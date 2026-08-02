// Demonstrates how the UNIQUE(run_id, step_id) constraint on
// idempotency_keys (migrations/schema.sql) is meant to be used by a step
// executor - the thing that actually performs a mock_external_action (or,
// eventually, a real one).
//
// The pattern: BEFORE performing the external side effect, try to INSERT a
// claim row for (run_id, step_id). If that insert succeeds, this is the
// first attempt - go ahead and perform the action, then call
// recordActionResult() to store what happened. If the insert fails
// because the row already exists (crash-and-retry, a duplicate request,
// two workers racing on the same step), the action must NOT be performed
// again - return the previously stored result instead.
//
// The safety property this buys us: even if two processes call
// claimIdempotentAction() for the same (run_id, step_id) at the exact same
// moment, SQLite's UNIQUE constraint means only one of those INSERTs can
// succeed. There's no "check then insert" race window in application code
// to get wrong, because the database itself is the thing enforcing
// uniqueness.
const crypto = require('crypto');

function claimIdempotentAction(db, { runId, stepId, actionName }) {
  const existing = db
    .prepare('SELECT response_snapshot FROM idempotency_keys WHERE run_id = ? AND step_id = ?')
    .get(runId, stepId);

  if (existing) {
    return {
      alreadyPerformed: true,
      responseSnapshot: existing.response_snapshot ? JSON.parse(existing.response_snapshot) : null,
    };
  }

  try {
    db.prepare(
      'INSERT INTO idempotency_keys (id, run_id, step_id, action_name) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), runId, stepId, actionName);
    return { alreadyPerformed: false, responseSnapshot: null };
  } catch (err) {
    // Lost a race against a concurrent claim for the same run+step -
    // someone else's INSERT landed between our SELECT and our INSERT.
    if (!/UNIQUE constraint failed/.test(err.message)) throw err;

    const row = db
      .prepare('SELECT response_snapshot FROM idempotency_keys WHERE run_id = ? AND step_id = ?')
      .get(runId, stepId);
    return {
      alreadyPerformed: true,
      responseSnapshot: row?.response_snapshot ? JSON.parse(row.response_snapshot) : null,
    };
  }
}

// Called once the (already claimed) action has actually run, so a future
// retry can return this result instead of performing the action again.
function recordActionResult(db, { runId, stepId, responseSnapshot }) {
  db.prepare('UPDATE idempotency_keys SET response_snapshot = ? WHERE run_id = ? AND step_id = ?').run(
    JSON.stringify(responseSnapshot),
    runId,
    stepId
  );
}

module.exports = { claimIdempotentAction, recordActionResult };
