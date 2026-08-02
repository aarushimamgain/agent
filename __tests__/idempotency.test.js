// Verifies the claim/record pattern in src/execution/idempotency.js
// actually prevents a duplicate external action, backed by a real
// in-memory SQLite database (not a mock) so the UNIQUE(run_id, step_id)
// constraint from migrations/schema.sql is genuinely exercised.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { claimIdempotentAction, recordActionResult } = require('../src/execution/idempotency');

function makeDbWithRun() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'schema.sql'), 'utf8'));

  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name) VALUES (?, ?)').run(workflowId, 'wf');
  db.prepare(
    'INSERT INTO workflow_versions (id, workflow_id, version_number, definition) VALUES (?, ?, 1, ?)'
  ).run(versionId, workflowId, '{}');
  db.prepare('INSERT INTO runs (id, workflow_id, workflow_version_id) VALUES (?, ?, ?)').run(
    runId,
    workflowId,
    versionId
  );

  return { db, runId };
}

test('first claim for a (run, step) succeeds and is not already performed', () => {
  const { db, runId } = makeDbWithRun();
  const result = claimIdempotentAction(db, { runId, stepId: 'notify', actionName: 'send_email' });
  assert.equal(result.alreadyPerformed, false);
});

test('a second claim for the same (run, step) reports already-performed instead of inserting a duplicate row', () => {
  const { db, runId } = makeDbWithRun();
  claimIdempotentAction(db, { runId, stepId: 'notify', actionName: 'send_email' });
  recordActionResult(db, { runId, stepId: 'notify', responseSnapshot: { status: 'sent' } });

  const retry = claimIdempotentAction(db, { runId, stepId: 'notify', actionName: 'send_email' });

  assert.equal(retry.alreadyPerformed, true);
  assert.deepEqual(retry.responseSnapshot, { status: 'sent' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n, 1);
});

test('different steps on the same run can each be claimed independently', () => {
  const { db, runId } = makeDbWithRun();
  const a = claimIdempotentAction(db, { runId, stepId: 'step_a', actionName: 'action_a' });
  const b = claimIdempotentAction(db, { runId, stepId: 'step_b', actionName: 'action_b' });

  assert.equal(a.alreadyPerformed, false);
  assert.equal(b.alreadyPerformed, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n, 2);
});
