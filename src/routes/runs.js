// Thin HTTP wrapper around src/execution/engine.js. Every route here does
// input-checking + one engine call + turning a thrown Error into an HTTP
// status; the actual state machine lives entirely in the engine module so
// it stays directly testable without spinning up Express (see
// __tests__/engine.test.js).
const express = require('express');
const { db } = require('../db');
const {
  createRun,
  advanceRun,
  approveStep,
  rejectStep,
  retryStep,
  cancelRun,
  resumeRun,
  recoverRun,
  getRunWithSteps,
} = require('../execution/engine');
const { explainRun } = require('../execution/explainRun');

const router = express.Router();

// Engine functions throw plain Errors for invalid state transitions (e.g.
// "approve a step that isn't paused") - those are client mistakes (400), not
// server failures, so every route funnels through this instead of a generic
// 500 handler.
function handle(res, fn) {
  try {
    fn();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// runs.input_data/final_output are stored as TEXT (see migrations/schema.sql)
// - parsed here so list endpoints hand the frontend real JSON, not a string
// to parse twice.
function formatRunSummary(row) {
  return {
    ...row,
    input_data: row.input_data ? JSON.parse(row.input_data) : null,
    final_output: row.final_output ? JSON.parse(row.final_output) : null,
  };
}

// Start a run against a specific workflow version - or, if `version_number`
// is omitted, the workflow's CURRENT published version. Accepting an
// explicit version is what lets the "rerun with new input" screen target an
// older version deliberately rather than always running whatever is
// current (each run is pinned to the version it names, same as any other
// run - see runs.workflow_version_id in migrations/schema.sql).
router.post('/workflows/:workflowId/runs', (req, res) => {
  handle(res, () => {
    const { workflowId } = req.params;
    const { input_data, created_by, version_number } = req.body;

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    let workflowVersionId = workflow.current_version_id;
    if (version_number !== undefined && version_number !== null) {
      const versionRow = db
        .prepare('SELECT id FROM workflow_versions WHERE workflow_id = ? AND version_number = ?')
        .get(workflowId, Number(version_number));
      if (!versionRow) return res.status(404).json({ error: `Version ${version_number} not found for this workflow.` });
      workflowVersionId = versionRow.id;
    }
    if (!workflowVersionId) {
      return res.status(422).json({ error: 'Workflow has no published version to run.' });
    }

    const run = createRun(db, {
      workflowId,
      workflowVersionId,
      inputData: input_data,
      createdBy: created_by,
    });
    res.status(201).json(run);
  });
});

// All runs for one workflow (most recent first) - used by the workflow
// detail page's "recent runs" list and to find the latest run to poll.
router.get('/workflows/:workflowId/runs', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.params.workflowId)
    .map(formatRunSummary);
  res.json(rows);
});

// Every run across every workflow (most recent first) - the run history
// screen. Joined with workflow name + version number so the list is
// displayable without a round trip per row.
router.get('/runs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT runs.*, workflows.name AS workflow_name, workflow_versions.version_number AS workflow_version_number
       FROM runs
       JOIN workflows ON workflows.id = runs.workflow_id
       JOIN workflow_versions ON workflow_versions.id = runs.workflow_version_id
       ORDER BY runs.created_at DESC
       LIMIT 200`
    )
    .all()
    .map(formatRunSummary);
  res.json(rows);
});

router.get('/runs/:runId', (req, res) => {
  const run = getRunWithSteps(db, req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    ...run,
    input_data: run.input_data ? JSON.parse(run.input_data) : null,
    final_output: run.final_output ? JSON.parse(run.final_output) : null,
    steps: run.steps.map((s) => ({
      ...s,
      input_snapshot: s.input_snapshot ? JSON.parse(s.input_snapshot) : null,
      output: s.output ? JSON.parse(s.output) : null,
    })),
  });
});

// Drives the run forward: processes steps until it pauses for approval,
// completes, fails, hits a cancellation, or (optionally) a step budget.
router.post('/runs/:runId/execute', (req, res) => {
  handle(res, () => {
    const { maxSteps } = req.body || {};
    const result = advanceRun(db, req.params.runId, maxSteps ? { maxSteps } : undefined);
    res.json(result);
  });
});

router.post('/runs/:runId/cancel', (req, res) => {
  handle(res, () => {
    const run = cancelRun(db, req.params.runId, req.body?.cancelled_by);
    res.json(run);
  });
});

router.post('/runs/:runId/resume', (req, res) => {
  handle(res, () => {
    const run = resumeRun(db, req.params.runId, req.body?.resumed_by);
    res.json(run);
  });
});

router.post('/runs/:runId/steps/:stepId/approve', (req, res) => {
  handle(res, () => {
    const run = approveStep(db, req.params.runId, req.params.stepId, req.body?.approved_by);
    res.json(run);
  });
});

router.post('/runs/:runId/steps/:stepId/reject', (req, res) => {
  handle(res, () => {
    const run = rejectStep(db, req.params.runId, req.params.stepId, req.body?.rejected_by);
    res.json(run);
  });
});

router.post('/runs/:runId/steps/:stepId/retry', (req, res) => {
  handle(res, () => {
    const run = retryStep(db, req.params.runId, req.params.stepId, req.body?.confirmed_by);
    res.json(run);
  });
});

// The raw, chronological audit_log trail for a run - distinct from
// /explanation below: this is every individual event as it was recorded
// (timestamp, event_type, status, payload), for a table view; /explanation
// is the same underlying data turned into plain-English sentences.
router.get('/runs/:runId/audit', (req, res) => {
  const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  // See the matching comment in src/execution/explainRun.js: rowid (insert
  // order), not `id` (a random UUID), is what makes this genuinely
  // chronological when several events share the same one-second timestamp.
  const rows = db
    .prepare('SELECT * FROM audit_log WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(req.params.runId)
    .map((row) => ({ ...row, payload: row.payload ? JSON.parse(row.payload) : null }));
  res.json(rows);
});

// Requirement 2: a plain-English trace of what happened during a run - why
// each branch was (or wasn't) taken, why any step was skipped, and how it
// ended. Purely a reader over audit_log/run_steps (see explainRun.js); it
// never touches run state.
router.get('/runs/:runId/explanation', (req, res) => {
  const explanation = explainRun(db, req.params.runId);
  if (!explanation) return res.status(404).json({ error: 'Run not found' });
  res.json(explanation);
});

// Requirement 3: recover a failed run by resetting only its failed step(s)
// back to 'pending' and continuing execution - completed/skipped steps are
// left untouched, and any external-action step picked back up this way is
// still protected by idempotency_keys.
router.post('/runs/:runId/recover', (req, res) => {
  handle(res, () => {
    const result = recoverRun(db, req.params.runId, {
      recoveredBy: req.body?.recovered_by,
      maxSteps: req.body?.maxSteps,
    });
    res.json(result);
  });
});

module.exports = router;
