// ============================================================================
// DESIGN NOTE: the run_steps state machine, and how idempotency is guaranteed
// ============================================================================
//
// STATES
// ------
// Every run_steps row is in exactly one of six states:
//
//   pending    the step hasn't been attempted yet (or is queued for a retry)
//   running    an attempt is currently in flight
//   succeeded  the step's handler returned a result; output is populated
//   failed     the step's handler threw and no more attempts will happen
//              automatically; needs a human (or a new workflow version) to
//              move forward
//   paused     the step is a human_approval step with no decision recorded
//              yet - the run itself is parked at status = 'waiting_approval'
//   skipped    this step was the untaken branch of a deterministic_condition
//              (or depends on a step that was) - it will never run in this run
//
// TRANSITIONS
// -----------
//   pending  -> running    engine picks the step up (advanceRun)
//   running  -> succeeded  handler returned a value
//   running  -> pending    handler threw AND the step type is retryable AND
//                          retry_count hasn't hit the cap yet (scheduleRetry)
//   running  -> failed     handler threw and no more automatic attempts are
//                          allowed (not retryable, or retries exhausted, or a
//                          permission check failed before the handler even ran)
//   pending  -> skipped    a deterministic_condition upstream chose the other
//                          branch, or a dependency of this step was skipped
//   pending  -> paused     step is human_approval, no decision recorded yet
//   paused   -> pending    a human recorded a decision (approveStep/rejectStep) -
//                          back to 'pending' so the readiness scan (which only
//                          ever looks at pending/running rows, in definition
//                          order) will pick this step up again ahead of any
//                          later step, instead of leaving it stuck at 'paused'
//                          forever and letting the run skip past it
//   pending  -> succeeded  (approved) | failed (rejected) - resolved the next
//                          time advanceRun reaches this step (see the
//                          human_approval case below)
//   failed   -> pending    a human explicitly confirmed a retry (retryStep) -
//                          the only way a non-auto-retryable step ever runs
//                          again
//
// A run's own `status` mirrors this at a coarser grain: pending -> running ->
// (waiting_approval <-> running)* -> completed | failed | cancelled. A run
// can be cancelled from pending, running, or waiting_approval, and resumed
// (cancelled -> running) later - see cancelRun/resumeRun below.
//
// WHY THIS SHAPE: SKIPPING BRANCHES, NOT JUST STEPS
// --------------------------------------------------
// A workflow is a graph, not a list: deterministic_condition steps only let
// ONE of `on_true`/`on_false` actually run. The moment a condition step
// succeeds, the engine immediately marks its NOT-chosen branch target as
// 'skipped' (see the deterministic_condition case in advanceRun). Any step
// that later turns out to depend (via `inputs`) on that skipped step is
// skipped too - stepShouldBeSkipped() below checks exactly that, and because
// the engine always processes steps in the workflow's own dependency order,
// this propagates correctly however many steps deep the skipped branch goes.
//
// WHY "PAUSE" MEANS PERSISTING STATE, NOT BLOCKING A CALL
// ---------------------------------------------------------
// advanceRun() is a plain synchronous function: it does some work and
// returns. When it hits a human_approval step with no decision yet, it does
// NOT block waiting for one - it writes run_steps.status = 'paused' and
// runs.status = 'waiting_approval' to SQLite and returns immediately. The
// Node process is free to restart, and the run picks back up correctly
// whenever something calls advanceRun() again (via the API's execute route),
// purely by reading these rows back out of the database. Nothing about the
// paused state lives in memory.
//
// WHY "CANCEL MID-EXECUTION" MEANS BETWEEN STEPS, NOT INSIDE ONE
// -----------------------------------------------------------------
// better-sqlite3 is synchronous and Node is single-threaded: while
// advanceRun() is executing, nothing else - including a concurrent
// POST /runs/:id/cancel request - can run until it returns. So "cancelled
// mid-execution" concretely means: advanceRun() re-reads the run's status
// from the database at the top of EVERY loop iteration (i.e. before each
// step), so a cancellation recorded by an earlier, separate call takes
// effect at the very next step boundary, and a run can be cancelled between
// any two steps of a multi-step execution. What is NOT true (and would be
// dishonest to claim) is that a cancel request can interrupt a step that is
// already `running`. Since every handler here is a fast, synchronous, local
// function (a mock), that window is negligible in practice; a real system
// with slow network-calling handlers would need to make each handler itself
// cancellation-aware, which is out of scope for this foundation.
//
// HOW THE UNIQUE CONSTRAINT GUARANTEES IDEMPOTENCY
// ---------------------------------------------------
// mock_external_action steps are the one place a run has a side effect
// outside its own database. executeMockExternalAction() below always calls
// claimIdempotentAction() (src/execution/idempotency.js) BEFORE invoking the
// mock action function - never after. That function's first move is an
// INSERT INTO idempotency_keys (..., run_id, step_id, ...) into a table with
// a UNIQUE(run_id, step_id) constraint (migrations/schema.sql). Two
// consequences follow directly from that constraint, not from any
// application logic remembering to check something first:
//   1. If this exact (run_id, step_id) pair has never been claimed, the
//      INSERT succeeds, and only THEN do we call the mock action function.
//   2. If it HAS already been claimed - because this is a retry after a
//      crash, a re-run of the same step, or (in principle) two concurrent
//      attempts - the INSERT fails with SQLITE_CONSTRAINT. The database
//      itself rejected the second attempt; the action function is never
//      called a second time. We catch that failure, look up what was
//      recorded for the first attempt, and return it unchanged.
// That means "no duplicate external actions" is a property of the schema,
// provable by trying to insert a duplicate row and watching SQLite refuse
// it (see __tests__/idempotency.test.js from the schema work, and
// __tests__/engine.test.js's idempotency test, which goes one step further
// and proves the mock action FUNCTION itself is only invoked once even
// when the engine attempts the step twice).
//
// FULL OBSERVABILITY: WHAT GETS WRITTEN TO audit_log, AND WHY IT'S ENOUGH
// TO EXPLAIN A RUN WITHOUT RE-RUNNING IT
// --------------------------------------------------------------------------
// Every event required for observability - an AI call, a tool call, a human
// approval decision, a retry attempt, a step failure, and a run's final
// result - is written to audit_log at the exact moment the engine decides
// it, via recordAudit() (src/auditLog.js). The important design choice is
// WHAT goes in `payload`: not just "condition evaluated to false", but the
// expression AND the actual resolved values it was compared against; not
// just "step skipped", but which upstream step/branch caused the skip. That
// means src/execution/explainRun.js (the human-readable trace endpoint) is
// a pure READER over already-recorded rows - it never re-evaluates a
// condition or re-derives why something happened, it just formats what was
// captured here. If explainRun's output ever looks wrong, the fix is always
// "log more detail here", never "add inference logic there".
//
// recoverRun() (near the bottom of this file) is what a failed run's
// recovery is built from: resetting the failed step(s) back to 'pending'
// and calling advanceRun() again - the exact same path a manual retryStep()
// followed by advanceRun() would take. Nothing new is needed to make
// recovery safe: skipped/succeeded steps are untouched (advanceRun only
// ever picks up 'pending'/'running' rows), and a mock_external_action step
// picked back up this way still goes through claimIdempotentAction, so
// recovering a run can never repeat an external action a previous attempt
// already completed.
// ============================================================================

const { STEP_TYPES, requiredToolForStep, auditCategoryForStep } = require('../schema/stepTypes');
const { claimIdempotentAction, recordActionResult } = require('./idempotency');
const { evaluateCondition } = require('./evaluateCondition');
const { renderTemplate } = require('./renderTemplate');
const { defaultHandlers } = require('./mocks');
const { recordAudit } = require('../auditLog');
const crypto = require('crypto');

// Total attempts allowed for a retryable step, including the first one -
// i.e. up to 2 automatic retries after an initial failure.
const MAX_AUTO_RETRIES = 3;

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

function getRun(db, runId) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
}

function getRunSteps(db, runId) {
  return db.prepare('SELECT * FROM run_steps WHERE run_id = ?').all(runId);
}

function loadDefinition(db, workflowVersionId) {
  const row = db.prepare('SELECT definition FROM workflow_versions WHERE id = ?').get(workflowVersionId);
  if (!row) throw new Error(`workflow_version ${workflowVersionId} not found`);
  return JSON.parse(row.definition);
}

// Builds { status, output } per step id from the current run_steps rows -
// the one piece of mutable state the whole tick's decisions are based on.
function buildStepStateById(stepRows) {
  const map = new Map();
  for (const row of stepRows) {
    map.set(row.step_id, { row, output: row.output ? JSON.parse(row.output) : null });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Graph helpers - same edge model as validateWorkflowDefinition.js (inputs
// references + deterministic_condition branches), used here to decide
// readiness and skip-propagation instead of cycle detection.
// ---------------------------------------------------------------------------

function computeBranchTargetOwner(definition) {
  const owner = new Map(); // targetStepId -> conditionStepId
  for (const step of definition.steps) {
    if (step.type !== 'deterministic_condition') continue;
    if (step.config.on_true) owner.set(step.config.on_true, step.id);
    if (step.config.on_false) owner.set(step.config.on_false, step.id);
  }
  return owner;
}

function isTerminalStatus(status) {
  return status === 'succeeded' || status === 'skipped' || status === 'failed';
}

function stepPrerequisitesSatisfied(step, branchTargetOwner, stateById) {
  for (const value of Object.values(step.inputs || {})) {
    if (value && typeof value === 'object' && 'from' in value) {
      const depState = stateById.get(value.from);
      if (!depState || !isTerminalStatus(depState.row.status)) return false;
    }
  }
  const owner = branchTargetOwner.get(step.id);
  if (owner) {
    const ownerState = stateById.get(owner);
    if (!ownerState || !isTerminalStatus(ownerState.row.status)) return false;
  }
  return true;
}

// A step is skipped (rather than run) if any step it reads output from was
// itself skipped - the propagation rule for "downstream of an untaken
// branch". A failed dependency is deliberately NOT a skip trigger here: a
// failed step halts the whole run immediately (see advanceRun), so we never
// reach a downstream step with a failed-not-skipped dependency in practice.
function stepShouldBeSkipped(step, stateById) {
  return Object.values(step.inputs || {}).some(
    (value) => value && typeof value === 'object' && 'from' in value && stateById.get(value.from)?.row.status === 'skipped'
  );
}

// Resolves a step's `inputs` into concrete values using already-succeeded
// steps' outputs. Only called once a step's prerequisites are confirmed
// satisfied and it isn't being skipped, so every referenced step is
// guaranteed to have succeeded (never pending/failed/skipped) by this point.
function resolveInputs(step, stateById) {
  const resolved = {};
  for (const [name, value] of Object.entries(step.inputs || {})) {
    if (value && typeof value === 'object' && 'from' in value) {
      const produced = stateById.get(value.from)?.output || {};
      resolved[name] = produced[value.output];
    } else {
      resolved[name] = value;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Persistence helpers - one UPDATE per state transition, so run_steps always
// reflects exactly what has actually happened, even if the process dies
// immediately after any single one of these calls returns.
// ---------------------------------------------------------------------------

function markRunRunning(db, runId) {
  db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(runId);
}
// Folds in the 'final_result' audit event so every call site that ends a
// run successfully doesn't have to remember to log it separately - there's
// exactly one place a run can complete, so there's exactly one place that
// records its final result.
function markRunCompleted(db, runId, finalOutput) {
  db.prepare("UPDATE runs SET status = 'completed', final_output = ?, completed_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(finalOutput ?? null),
    runId
  );
  recordAudit(db, { runId, eventType: 'final_result', status: 'completed', payload: { final_output: finalOutput ?? null }, actor: 'system' });
}
// Same idea for the failure path: whatever caused it (a step exhausting
// retries, a rejected approval, a bad condition expression), this is the
// one place a run transitions to 'failed', so it's the one place that logs it.
function markRunFailed(db, runId, error) {
  db.prepare("UPDATE runs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?").run(error, runId);
  recordAudit(db, { runId, eventType: 'final_result', status: 'failed', payload: { error }, actor: 'system' });
}
function markRunWaitingApproval(db, runId) {
  db.prepare("UPDATE runs SET status = 'waiting_approval' WHERE id = ?").run(runId);
}
function markRunCancelled(db, runId) {
  db.prepare("UPDATE runs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?").run(runId);
}

function markStepRunning(db, runId, stepId) {
  db.prepare(
    "UPDATE run_steps SET status = 'running', started_at = COALESCE(started_at, datetime('now')), error = NULL WHERE run_id = ? AND step_id = ?"
  ).run(runId, stepId);
}
function persistStepSuccess(db, runId, stepId, inputSnapshot, output) {
  db.prepare(
    "UPDATE run_steps SET status = 'succeeded', input_snapshot = ?, output = ?, error = NULL, completed_at = datetime('now') WHERE run_id = ? AND step_id = ?"
  ).run(JSON.stringify(inputSnapshot), JSON.stringify(output), runId, stepId);
}
// stepType is only needed for the audit payload (which kind of step failed)
// - every code path that can fail a step already has the step definition in
// scope, so this never requires an extra lookup.
function persistStepFailure(db, runId, stepId, stepType, error) {
  db.prepare("UPDATE run_steps SET status = 'failed', error = ?, completed_at = datetime('now') WHERE run_id = ? AND step_id = ?").run(
    error,
    runId,
    stepId
  );
  recordAudit(db, { runId, stepId, eventType: 'failure', status: 'failed', payload: { step_type: stepType, error }, actor: 'system' });
}
// reason is a plain-English sentence (not just a code) precisely because
// explainRun.js's whole approach is "format what was recorded", never
// "re-derive it" - the reason has to already read like an explanation.
function markStepSkipped(db, runId, stepId, reason) {
  db.prepare("UPDATE run_steps SET status = 'skipped', completed_at = datetime('now') WHERE run_id = ? AND step_id = ?").run(runId, stepId);
  recordAudit(db, { runId, stepId, eventType: 'step_skipped', status: 'skipped', payload: { reason }, actor: 'system' });
}
function markStepPaused(db, runId, stepId) {
  db.prepare("UPDATE run_steps SET status = 'paused' WHERE run_id = ? AND step_id = ?").run(runId, stepId);
}
// Failed-but-retryable: goes back to 'pending' (not 'failed') so the next
// advanceRun tick picks it up again, with the attempt counted and the error
// visible in the meantime.
function scheduleRetry(db, runId, stepId, stepType, error, attempt, maxAttempts) {
  db.prepare(
    "UPDATE run_steps SET status = 'pending', retry_count = retry_count + 1, error = ? WHERE run_id = ? AND step_id = ?"
  ).run(error, runId, stepId);
  recordAudit(db, {
    runId,
    stepId,
    eventType: 'retry_attempt',
    status: 'scheduled',
    payload: { step_type: stepType, manual: false, attempt, max_attempts: maxAttempts, error },
    actor: 'system',
  });
}

// ---------------------------------------------------------------------------
// Permission enforcement (requirement 6) - checked before ANY handler runs,
// for every step type that has a fixed or configured tool identifier (see
// requiredToolForStep in src/schema/stepTypes.js).
// ---------------------------------------------------------------------------

function assertToolPermission(step) {
  const tool = requiredToolForStep(step);
  if (!tool) return null; // this step type never calls a tool
  const allowed = step.permissions?.tools || [];
  if (!allowed.includes(tool)) {
    throw new Error(`Step "${step.id}" attempted to use tool "${tool}", which is not declared in its permissions.tools.`);
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

// mock_external_action's handler, wired through the idempotency guarantee.
// See the design note above for exactly why this makes duplicates
// impossible rather than just unlikely.
function executeMockExternalAction(db, runId, step, resolvedInputs, actionHandler) {
  const claim = claimIdempotentAction(db, { runId, stepId: step.id, actionName: step.config.action_name });
  if (claim.alreadyPerformed) {
    return { ...(claim.responseSnapshot || {}), idempotent_replay: true };
  }
  const response = actionHandler(resolvedInputs, step.config);
  recordActionResult(db, { runId, stepId: step.id, responseSnapshot: response });
  return response;
}

function runHandler(step, resolvedInputs, run, handlers, db) {
  switch (step.type) {
    case 'structured_input':
      return JSON.parse(run.input_data || '{}');
    case 'document_retrieval':
      return handlers.document_retrieval(resolvedInputs, step.config);
    case 'ai_extraction':
      return handlers.ai_extraction(resolvedInputs, step.config);
    case 'ai_classification':
      return handlers.ai_classification(resolvedInputs, step.config);
    case 'final_report':
      return { report: renderTemplate(step.config.template, resolvedInputs) };
    case 'mock_external_action':
      return executeMockExternalAction(db, run.id, step, resolvedInputs, handlers.mock_external_action);
    default:
      // deterministic_condition and human_approval never reach here - both
      // are handled directly in advanceRun() because they need to do more
      // than "compute an output" (branch-skipping, pausing).
      throw new Error(`No handler for step type "${step.type}".`);
  }
}

// Executes exactly one attempt of one step and persists the outcome.
// Returns 'succeeded' | 'retrying' | 'failed'. Never throws - failures are
// reported in the return value, since a thrown handler error is an expected,
// routine outcome here, not a bug in the engine.
//
// `category` (from auditCategoryForStep) is 'ai_call', 'tool_call', or null.
// Every step whose category isn't null gets exactly one audit_log row per
// attempt reflecting what actually happened to it: 'denied' if the
// permission check failed, 'success' if the handler returned, 'failure' if
// it threw - so "every AI call" and "every tool call" in the observability
// requirement covers denied and failed attempts too, not just successes.
function attemptStep(db, run, step, stepRow, handlers) {
  markStepRunning(db, run.id, step.id);
  const category = auditCategoryForStep(step);

  let resolvedInputs;
  try {
    const stateById = buildStepStateById(getRunSteps(db, run.id));
    resolvedInputs = resolveInputs(step, stateById);
  } catch (err) {
    persistStepFailure(db, run.id, step.id, step.type, `Failed to resolve inputs: ${err.message}`);
    return { outcome: 'failed', error: err.message };
  }

  let requiredTool;
  try {
    requiredTool = assertToolPermission(step);
  } catch (err) {
    if (category) {
      recordAudit(db, {
        runId: run.id,
        stepId: step.id,
        eventType: category,
        status: 'denied',
        payload: { tool: requiredToolForStep(step), reason: err.message },
        actor: 'system',
      });
    }
    persistStepFailure(db, run.id, step.id, step.type, err.message);
    return { outcome: 'failed', error: err.message };
  }

  try {
    const output = runHandler(step, resolvedInputs, run, handlers, db);
    persistStepSuccess(db, run.id, step.id, resolvedInputs, output);
    if (category) {
      recordAudit(db, {
        runId: run.id,
        stepId: step.id,
        eventType: category,
        status: 'success',
        payload: { tool: requiredTool, inputs: resolvedInputs, output },
        actor: 'system',
      });
    }
    return { outcome: 'succeeded', output };
  } catch (err) {
    if (category) {
      recordAudit(db, {
        runId: run.id,
        stepId: step.id,
        eventType: category,
        status: 'failure',
        payload: { tool: requiredTool, inputs: resolvedInputs, error: err.message },
        actor: 'system',
      });
    }
    const spec = STEP_TYPES[step.type];
    if (spec.retryable && stepRow.retry_count + 1 < MAX_AUTO_RETRIES) {
      scheduleRetry(db, run.id, step.id, step.type, err.message, stepRow.retry_count + 1, MAX_AUTO_RETRIES);
      return { outcome: 'retrying', error: err.message };
    }
    persistStepFailure(db, run.id, step.id, step.type, err.message);
    return { outcome: 'failed', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Creates a run and pre-creates a 'pending' run_steps row for every step in
// the definition. Pre-creating all rows up front (rather than inserting them
// as execution reaches them) is what lets advanceRun() figure out "where was
// I" purely by querying run_steps - there's no separate in-memory execution
// plan to reconstruct after a restart.
function createRun(db, { workflowId, workflowVersionId, inputData, createdBy }) {
  const definition = loadDefinition(db, workflowVersionId);

  const entryStep = definition.steps.find((s) => s.type === 'structured_input');
  if (entryStep) {
    const missing = (entryStep.config.fields || [])
      .map((f) => f.name)
      .filter((name) => !(inputData && Object.prototype.hasOwnProperty.call(inputData, name)));
    if (missing.length > 0) {
      throw new Error(`input_data is missing required field(s): ${missing.join(', ')}`);
    }
  }

  const runId = crypto.randomUUID();
  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_version_id, input_data, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(runId, workflowId, workflowVersionId, JSON.stringify(inputData || {}), createdBy || null);

    const insertStep = db.prepare(
      `INSERT INTO run_steps (id, run_id, step_id, step_type) VALUES (?, ?, ?, ?)`
    );
    for (const step of definition.steps) {
      insertStep.run(crypto.randomUUID(), runId, step.id, step.type);
    }
  });
  create();

  recordAudit(db, {
    runId,
    eventType: 'run_created',
    status: 'created',
    payload: { workflow_id: workflowId, workflow_version_id: workflowVersionId, input_data: inputData || {} },
    actor: createdBy,
  });
  return getRun(db, runId);
}

// Advances a run: picks up where run_steps left off and keeps processing
// steps until the run pauses for approval, completes, fails, is found
// cancelled, or `maxSteps` worth of steps have been processed (default
// unbounded - process until a natural stopping point). Safe to call
// repeatedly and from a fresh process each time; all state it needs comes
// from the database. `handlers` defaults to the deterministic mocks in
// mocks.js and can be overridden (e.g. in tests) with the same shape.
function advanceRun(db, runId, { handlers = defaultHandlers, maxSteps = Infinity } = {}) {
  let processed = 0;

  while (processed < maxSteps) {
    const run = getRun(db, runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    if (run.status === 'cancelled') return { status: 'cancelled' };
    if (run.status === 'completed' || run.status === 'failed') return { status: run.status };
    if (run.status === 'waiting_approval') return { status: 'waiting_approval' };
    if (run.status === 'pending') markRunRunning(db, runId);

    const definition = loadDefinition(db, run.workflow_version_id);
    const branchTargetOwner = computeBranchTargetOwner(definition);
    const stateById = buildStepStateById(getRunSteps(db, runId));

    const next = definition.steps.find((step) => {
      const status = stateById.get(step.id)?.row.status;
      return (status === 'pending' || status === 'running') && stepPrerequisitesSatisfied(step, branchTargetOwner, stateById);
    });

    if (!next) {
      const rows = [...stateById.values()].map((s) => s.row);
      const stillUnfinished = rows.some((r) => r.status === 'pending' || r.status === 'running');
      if (stillUnfinished) {
        // An acyclic, validated definition should never get stuck; surfacing
        // this distinctly makes it obvious if that invariant is ever broken.
        return { status: run.status, stuck: true };
      }
      const finalReportStep = [...definition.steps].reverse().find((s) => s.type === 'final_report');
      const finalOutput = finalReportStep ? stateById.get(finalReportStep.id)?.output : null;
      markRunCompleted(db, runId, finalOutput);
      return { status: 'completed' };
    }

    if (stepShouldBeSkipped(next, stateById)) {
      const skippedDependency = Object.entries(next.inputs || {}).find(
        ([, value]) => value && typeof value === 'object' && 'from' in value && stateById.get(value.from)?.row.status === 'skipped'
      );
      const reason = skippedDependency
        ? `Depends on step "${skippedDependency[1].from}", which was itself skipped.`
        : 'An upstream dependency was skipped.';
      markStepSkipped(db, runId, next.id, reason);
      processed++;
      continue;
    }

    const stepRow = stateById.get(next.id).row;

    if (next.type === 'human_approval') {
      if (!stepRow.approval_decision) {
        markStepPaused(db, runId, next.id);
        markRunWaitingApproval(db, runId);
        recordAudit(db, {
          runId,
          stepId: next.id,
          eventType: 'approval_requested',
          status: 'pending',
          payload: { approvers: next.config.approvers, message: next.config.message },
          actor: 'system',
        });
        return { status: 'waiting_approval', stepId: next.id };
      }
      if (stepRow.approval_decision === 'rejected') {
        const error = `Rejected by ${stepRow.approved_by || 'unknown'}`;
        persistStepFailure(db, runId, next.id, next.type, error);
        markRunFailed(db, runId, `Step "${next.id}" was rejected`);
        return { status: 'failed', stepId: next.id, error };
      }
      persistStepSuccess(db, runId, next.id, {}, {
        decision: 'approved',
        approved_by: stepRow.approved_by,
        approved_at: stepRow.approved_at,
      });
      processed++;
      continue;
    }

    if (next.type === 'deterministic_condition') {
      const resolvedInputs = resolveInputs(next, stateById);
      let decision;
      try {
        decision = evaluateCondition(next.config.expression, resolvedInputs);
      } catch (err) {
        persistStepFailure(db, runId, next.id, next.type, err.message);
        markRunFailed(db, runId, err.message);
        return { status: 'failed', stepId: next.id, error: err.message };
      }
      const chosen = decision ? next.config.on_true : next.config.on_false;
      const notChosen = decision ? next.config.on_false : next.config.on_true;
      persistStepSuccess(db, runId, next.id, resolvedInputs, { decision, branch_taken: chosen || null });
      // condition_evaluated carries the expression AND the actual resolved
      // values it was compared against (not just true/false) - this one
      // payload is what lets explainRun.js show "why" in plain English.
      recordAudit(db, {
        runId,
        stepId: next.id,
        eventType: 'condition_evaluated',
        status: decision ? 'true' : 'false',
        payload: { expression: next.config.expression, resolved_inputs: resolvedInputs, decision, branch_taken: chosen || null, branch_skipped: notChosen || null },
        actor: 'system',
      });
      if (notChosen) {
        markStepSkipped(
          db,
          runId,
          notChosen,
          `Condition "${next.id}" ("${next.config.expression}") evaluated to ${decision}, so branch "${notChosen}" was not taken.`
        );
      }
      processed++;
      continue;
    }

    const result = attemptStep(db, run, next, stepRow, handlers);
    processed++;
    if (result.outcome === 'failed') {
      markRunFailed(db, runId, result.error);
      return { status: 'failed', stepId: next.id, error: result.error };
    }
    // 'succeeded' or 'retrying' both just continue the loop.
  }

  return { status: 'running', maxStepsReached: true };
}

// Human-approval resolution. Both approveStep and rejectStep only RECORD the
// decision and hand the run back to 'running' - they deliberately don't call
// advanceRun() themselves, so "a decision was recorded" and "the run
// continued" stay two separate, auditable actions.
function approveStep(db, runId, stepId, approvedBy) {
  const run = getRun(db, runId);
  if (!run || run.status !== 'waiting_approval') throw new Error('Run is not waiting for approval.');
  const stepRow = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?').get(runId, stepId);
  if (!stepRow || stepRow.status !== 'paused') throw new Error(`Step "${stepId}" is not currently paused for approval.`);

  // Back to 'pending', not left at 'paused': advanceRun's readiness scan
  // only ever considers 'pending'/'running' rows, and scans in the
  // definition's own step order - so this also guarantees the approval
  // step gets resolved before any later, independent step is allowed to
  // run, even though the run's overall status went back to 'running'.
  db.prepare(
    "UPDATE run_steps SET status = 'pending', approval_decision = 'approved', approved_by = ?, approved_at = datetime('now') WHERE run_id = ? AND step_id = ?"
  ).run(approvedBy || null, runId, stepId);
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  recordAudit(db, { runId, stepId, eventType: 'approval_decision', status: 'approved', payload: { approved_by: approvedBy }, actor: approvedBy });
  return getRun(db, runId);
}

function rejectStep(db, runId, stepId, rejectedBy) {
  const run = getRun(db, runId);
  if (!run || run.status !== 'waiting_approval') throw new Error('Run is not waiting for approval.');
  const stepRow = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?').get(runId, stepId);
  if (!stepRow || stepRow.status !== 'paused') throw new Error(`Step "${stepId}" is not currently paused for approval.`);

  db.prepare(
    "UPDATE run_steps SET status = 'pending', approval_decision = 'rejected', approved_by = ?, approved_at = datetime('now') WHERE run_id = ? AND step_id = ?"
  ).run(rejectedBy || null, runId, stepId);
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  recordAudit(db, { runId, stepId, eventType: 'approval_decision', status: 'rejected', payload: { rejected_by: rejectedBy }, actor: rejectedBy });
  return getRun(db, runId);
}

// Manual retry confirmation (requirement 5): the only way a `failed` step
// runs again when its type isn't auto-retryable, but usable on any failed
// step (including a retryable one that exhausted its automatic attempts).
function retryStep(db, runId, stepId, confirmedBy) {
  const run = getRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const stepRow = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?').get(runId, stepId);
  if (!stepRow || stepRow.status !== 'failed') throw new Error(`Step "${stepId}" is not currently failed.`);

  db.prepare("UPDATE run_steps SET status = 'pending', error = NULL WHERE run_id = ? AND step_id = ?").run(runId, stepId);
  if (run.status === 'failed') {
    db.prepare("UPDATE runs SET status = 'running', error = NULL, completed_at = NULL WHERE id = ?").run(runId);
  }
  recordAudit(db, {
    runId,
    stepId,
    eventType: 'retry_attempt',
    status: 'confirmed',
    payload: { manual: true, previous_error: stepRow.error },
    actor: confirmedBy,
  });
  return getRun(db, runId);
}

// Cancellation (requirement 3): only flips runs.status. run_steps rows are
// left exactly as they are - nothing "completed" is touched, which combined
// with advanceRun() only ever selecting 'pending'/'running' steps is what
// guarantees a resumed run never repeats a step that already succeeded or
// was skipped.
function cancelRun(db, runId, cancelledBy) {
  const run = getRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!['pending', 'running', 'waiting_approval'].includes(run.status)) {
    throw new Error(`Run is already in a terminal state (${run.status}) and cannot be cancelled.`);
  }
  markRunCancelled(db, runId);
  recordAudit(db, { runId, eventType: 'run_cancelled', status: 'cancelled', actor: cancelledBy });
  return getRun(db, runId);
}

function resumeRun(db, runId, resumedBy) {
  const run = getRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== 'cancelled') throw new Error(`Run is not cancelled (current status: ${run.status}).`);
  db.prepare("UPDATE runs SET status = 'running', completed_at = NULL WHERE id = ?").run(runId);
  recordAudit(db, { runId, eventType: 'run_resumed', status: 'running', actor: resumedBy });
  return getRun(db, runId);
}

// Recovery (observability requirement 3): given a run that halted with
// status 'failed', reset whichever run_steps row(s) are currently 'failed'
// back to 'pending' and continue execution via advanceRun(). This is
// deliberately not a new mechanism - it's "confirm a retry (retryStep's own
// logic, inlined here so multiple failed rows can be reset in one
// transaction), then keep going" as a single call. Steps that already
// succeeded or were skipped are never touched (advanceRun only ever
// re-examines 'pending'/'running' rows), and a mock_external_action step
// picked back up this way still goes through claimIdempotentAction before
// its handler runs, so recovering a run can never re-trigger an external
// action a previous attempt already completed.
function recoverRun(db, runId, { recoveredBy, handlers, maxSteps } = {}) {
  const run = getRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== 'failed') {
    throw new Error(`Run is not in a failed state (current status: ${run.status}); there is nothing to recover.`);
  }

  const failedSteps = getRunSteps(db, runId).filter((s) => s.status === 'failed');
  if (failedSteps.length === 0) {
    throw new Error('Run is marked failed but has no failed step - nothing to recover.');
  }

  const resetFailedSteps = db.transaction(() => {
    for (const stepRow of failedSteps) {
      db.prepare("UPDATE run_steps SET status = 'pending', error = NULL WHERE id = ?").run(stepRow.id);
    }
    db.prepare("UPDATE runs SET status = 'running', error = NULL, completed_at = NULL WHERE id = ?").run(runId);
  });
  resetFailedSteps();

  for (const stepRow of failedSteps) {
    recordAudit(db, {
      runId,
      stepId: stepRow.step_id,
      eventType: 'retry_attempt',
      status: 'confirmed',
      payload: { manual: true, recovered: true, previous_error: stepRow.error },
      actor: recoveredBy,
    });
  }
  recordAudit(db, {
    runId,
    eventType: 'run_resumed',
    status: 'recovering',
    payload: { recovered_steps: failedSteps.map((s) => s.step_id) },
    actor: recoveredBy,
  });

  return advanceRun(db, runId, { handlers, maxSteps });
}

function getRunWithSteps(db, runId) {
  const run = getRun(db, runId);
  if (!run) return null;
  return { ...run, steps: getRunSteps(db, runId) };
}

module.exports = {
  MAX_AUTO_RETRIES,
  createRun,
  advanceRun,
  approveStep,
  rejectStep,
  retryStep,
  cancelRun,
  resumeRun,
  recoverRun,
  getRun,
  getRunSteps,
  getRunWithSteps,
  loadDefinition,
};
