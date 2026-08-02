-- Full schema for the workflow platform's SQLite database. Applied by
-- src/setupDatabase.js on server startup (see that file for when/how).
--
-- Every statement here is written to be safely re-runnable (CREATE TABLE
-- IF NOT EXISTS / CREATE INDEX IF NOT EXISTS), so this file doubles as both
-- the "first run" migration and a no-op sanity check on every later boot -
-- there is no separate migration-tracking table to keep in sync.
--
-- A few things are true of every table below because of SQLite specifically:
--   - There's no server-generated UUID function (no pgcrypto/gen_random_uuid
--     equivalent), so every `id` is a TEXT primary key populated by the
--     application with crypto.randomUUID() before insert, not a DB default.
--   - There's no native JSON/JSONB column type, so JSON payloads (a
--     workflow definition, a step's config, audit metadata) are stored as
--     TEXT and JSON.parse/stringify'd in the application layer.
--   - Timestamps are stored as TEXT in ISO-8601 form. `datetime('now')`
--     gives us a sensible default for *_created_at columns; columns the
--     application sets explicitly later (started_at, completed_at, ...)
--     have no default and start out NULL.

-- workflows: the "folder" a workflow lives in - identity/metadata that
-- stays constant across versions (name, description, who owns it). The
-- runnable definition is never stored here; it lives in workflow_versions,
-- which is immutable. That split is the core design decision of this
-- schema: "workflows" answers "what is this thing called", "workflow_versions"
-- answers "what did it actually do at the time a given run executed".
--
-- current_version_id points at "the version new runs should start
-- against". It references a table (workflow_versions) that isn't created
-- until further down this file - SQLite defers foreign key *target*
-- resolution until the reference is actually used (an insert/update),
-- not until CREATE TABLE, so this forward reference is safe as long as
-- workflow_versions exists by the time anyone writes to this column. That
-- lets us declare the column here, once, instead of a separate non-
-- idempotent ALTER TABLE statement later.
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  current_version_id TEXT REFERENCES workflow_versions(id),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- workflow_versions: an immutable, versioned snapshot of a workflow's
-- definition (the JSON described in src/schema/workflowDefinition.schema.json).
--
-- Why immutable + versioned instead of editing a single `definition`
-- column on workflows in place?
--   1. Every run must be reproducible: a run started against v3 of a
--      workflow must keep behaving like v3 forever, even if v4 is
--      published five minutes later. runs.workflow_version_id (below)
--      pins each run to the exact definition it executed against.
--   2. It gives us version comparison (diff v2 vs v3) for free, since both
--      sides of a diff are just rows in this table.
--   3. Audit/compliance: "what did this workflow do on a given date" is a
--      lookup, not archaeology.
--
-- Immutability is enforced at the application layer (the API only ever
-- INSERTs a new row here, never UPDATEs) rather than with a SQL trigger, to
-- keep this schema simple to read end to end.
CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  definition TEXT NOT NULL, -- JSON, validated by validateWorkflowDefinition() before insert
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- version numbers are sequential per workflow (1, 2, 3, ...) and never reused
  UNIQUE (workflow_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow_id ON workflow_versions(workflow_id);

-- runs: one row per execution attempt of a workflow.
--
-- A run always points at a specific workflow_version_id (not just a
-- workflow_id) so publishing a new version never changes the behavior of a
-- run that's already in flight or already completed. workflow_id is kept
-- too, purely so "every run of this workflow across all its versions" is a
-- single indexed lookup instead of a join through workflow_versions.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),

  input_data TEXT,   -- JSON: the structured_input step's data that kicked off this run
  final_output TEXT, -- JSON: populated once status reaches a terminal state
  error TEXT,

  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT -- set whenever status reaches ANY terminal state: completed, failed, or cancelled
);

CREATE INDEX IF NOT EXISTS idx_runs_workflow_id ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_workflow_version_id ON runs(workflow_version_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- run_steps: one row per step, per run - the execution state machine. This
-- is the table an operator/dashboard reads to answer "where is run X right
-- now, and what did each step produce". See "THE STATE MACHINE" in
-- src/execution/engine.js for the full write-up of every status and the
-- transitions the executor is allowed to make between them; the short
-- version:
--   pending   -> running    (executor picks the step up to actually execute it)
--   running   -> succeeded  (handler returned a result)
--   running   -> pending    (handler threw, step type is auto-retryable, and
--                             the retry cap hasn't been hit yet - retry_count++)
--   running   -> failed     (handler threw, and either the step type isn't
--                             auto-retryable or auto-retries were exhausted)
--   pending   -> paused     (step is human_approval and has no decision yet -
--                             this one skips 'running' entirely, since
--                             "waiting on a human" was never an execution
--                             attempt)
--   paused    -> pending    (a human recorded approved/rejected via the API -
--                             back to 'pending' so the next tick resolves it)
--   pending   -> skipped    (this step was the untaken branch of a
--                             deterministic_condition, or depends on a
--                             step that was)
--   failed    -> pending    (a human explicitly confirmed a retry, for
--                             step types that don't auto-retry)
--
-- step_id/step_type are copied from the workflow_version's definition at
-- run-start time (rather than only being derivable by re-reading the
-- definition JSON) so this table stays a self-contained execution record,
-- queryable/indexable on step_type without reaching into JSON.
--
-- approved_by/approved_at/approval_decision live here (not a separate
-- table) because approval is just one more thing that happens to a step;
-- a separate table would mean joining back to run_steps for almost every
-- query anyway.
--
-- retry_count only tracks AUTOMATIC retries (see STEP_TYPES.retryable in
-- src/schema/stepTypes.js) - a manually-confirmed retry of a
-- non-retryable step resets the row to 'pending' rather than incrementing
-- this counter, since that's a fresh, human-authorized attempt rather than
-- the engine's own retry loop.
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  step_id TEXT NOT NULL,   -- matches a step's `id` in the workflow definition
  step_type TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'paused', 'skipped')),

  input_snapshot TEXT,  -- JSON: resolved inputs (literals + referenced prior outputs), as this step actually saw them
  output TEXT,          -- JSON
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,

  -- only meaningful for step_type = 'human_approval'
  approved_by TEXT,
  approved_at TEXT,
  approval_decision TEXT CHECK (approval_decision IN ('approved', 'rejected') OR approval_decision IS NULL),

  started_at TEXT,
  completed_at TEXT, -- set whenever status reaches ANY terminal state (succeeded/failed/skipped), not just success
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- a given step id can only appear once per run
  UNIQUE (run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_run_steps_status ON run_steps(status);

-- idempotency_keys: the database-level guarantee that a given (run, step)
-- pair never triggers its external side effect more than once.
--
-- Steps like mock_external_action (and eventually real external actions)
-- call out to something outside our own database - a payment, an email, a
-- ticket creation. If the process crashes after the call succeeds but
-- before run_steps.status is written as 'completed', a naive retry would
-- call out a second time. Instead, the executor must INSERT a row here
-- *before* performing the side effect: the UNIQUE(run_id, step_id)
-- constraint means a second attempt's INSERT fails at the database level
-- (SQLITE_CONSTRAINT), not because application code remembered to check
-- first. See src/execution/idempotency.js for the two functions that use
-- this table.
--
-- This is intentionally its own table rather than a column on run_steps:
-- run_steps rows are created ahead of execution (status='pending') for
-- every step in the definition, but a row should only ever appear here for
-- a step that actually attempted its external action - so "a row exists"
-- and "a step exists" are different, useful facts.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  action_name TEXT NOT NULL,
  response_snapshot TEXT, -- JSON: the result of the action, filled in once known, so a retry can return it without re-calling anything
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_run_id ON idempotency_keys(run_id);

-- audit_log: an append-only trail of every consequential event on the
-- platform, and specifically the backbone of "full observability" for run
-- execution - every AI call, tool call, human approval decision, retry
-- attempt, step failure, and final result is a row here (see
-- src/execution/engine.js, which is the only code that writes to this
-- table during a run, via src/auditLog.js's recordAudit()).
--
-- run_id/step_id are nullable and deliberately loose (not foreign keys):
-- step_id stores the workflow definition's own step id string (the same
-- value as run_steps.step_id), not a row id, so a reader never needs a
-- join to know which step an event is about. Both are NULL for events that
-- aren't about a specific run at all (workflow_created, version_created,
-- version_published) - audit_log covers workflow-lifecycle events too, not
-- just execution events, which is why it isn't just a table on `runs`.
--
-- event_type is a closed vocabulary (CHECK constraint) rather than a free
-- string so the full list of "things that get audited" is readable in one
-- place in this schema, and a typo'd event_type fails loudly at insert time
-- instead of silently fragmenting the trail. status's meaning depends on
-- event_type (e.g. 'success'/'failure'/'denied' for ai_call/tool_call,
-- 'true'/'false' for condition_evaluated, 'approved'/'rejected' for
-- approval_decision) - see the recordAudit() call sites in engine.js for
-- the exact status values each event_type uses.
--
-- payload carries the structured detail a plain-English explanation is
-- built from later (src/execution/explainRun.js): for condition_evaluated
-- that means the expression AND the actual resolved values compared, not
-- just the true/false outcome, so "why" can be reconstructed without
-- re-running anything.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,

  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT, -- workflow definition step id (run_steps.step_id); NULL for run-level or workflow-level events

  event_type TEXT NOT NULL CHECK (event_type IN (
    'workflow_created', 'version_created', 'version_published',
    'run_created', 'run_cancelled', 'run_resumed',
    'ai_call', 'tool_call',
    'approval_requested', 'approval_decision',
    'condition_evaluated', 'step_skipped',
    'retry_attempt', 'failure', 'final_result'
  )),
  status TEXT NOT NULL, -- outcome label; meaning is event_type-specific, see engine.js
  payload TEXT,          -- JSON: structured detail specific to this event_type
  actor TEXT,            -- who/what caused this ('system' for engine-driven events, a user identifier otherwise)

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_run_id ON audit_log(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_run_step ON audit_log(run_id, step_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
