// Tests for the observability layer on top of the execution engine:
// - every required event category lands in audit_log with a JSON payload
// - the /explanation reader produces a plain-English trace of a run
// - the /recover flow resumes a failed run without repeating completed
//   steps, and without ever double-executing an external action
const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, publishDefinition } = require('./helpers/testHarness');
const { validateWorkflowDefinition } = require('../src/validation/validateWorkflowDefinition');
const { createRun, advanceRun, approveStep, recoverRun, retryStep, getRunSteps } = require('../src/execution/engine');
const { explainRun } = require('../src/execution/explainRun');

function definitionFor(steps, name = 'observability test workflow') {
  const definition = { name, steps };
  const result = validateWorkflowDefinition(definition);
  assert.equal(result.valid, true, `test fixture should be valid: ${JSON.stringify(result.errors)}`);
  return definition;
}

function auditRowsFor(db, runId) {
  // rowid (insert order), not `id` (a random UUID), is the correct
  // chronological tiebreaker - see the matching comment in explainRun.js.
  return db
    .prepare('SELECT * FROM audit_log WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(runId)
    .map((row) => ({ ...row, payload: row.payload ? JSON.parse(row.payload) : null }));
}

// ---------------------------------------------------------------------------
// Scenario 1: a failure mid-run, then recovery via /recover, without
// repeating the steps that already succeeded.
// ---------------------------------------------------------------------------

test('recoverRun resumes a failed run and does not repeat already-succeeded steps', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'fetch',
      type: 'document_retrieval',
      inputs: {},
      config: { source: 's3', query: 'q' },
      permissions: { tools: ['document_store.read'] },
    },
    {
      id: 'notify',
      type: 'mock_external_action',
      inputs: {},
      config: { action_name: 'send_email', mock_response: { status: 'queued' } },
      permissions: { tools: ['send_email'] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  let fetchCalls = 0;
  let notifyCalls = 0;
  const handlers = {
    document_retrieval: () => {
      fetchCalls++;
      return { content: 'doc' };
    },
    mock_external_action: () => {
      notifyCalls++;
      throw new Error('email service unreachable');
    },
  };

  const firstResult = advanceRun(db, run.id, { handlers });
  assert.equal(firstResult.status, 'failed');
  assert.equal(fetchCalls, 1);
  assert.equal(notifyCalls, 1);

  const stepsAfterFailure = getRunSteps(db, run.id);
  assert.equal(stepsAfterFailure.find((s) => s.step_id === 'fetch').status, 'succeeded');
  assert.equal(stepsAfterFailure.find((s) => s.step_id === 'notify').status, 'failed');

  // notify's idempotency claim was already inserted on the FIRST attempt,
  // before its handler threw (see the design note in engine.js: the claim
  // happens before the action runs, not after). So on recovery, even with a
  // handler that would now succeed, the engine must find that existing
  // claim and skip calling the handler again entirely - `fetch` must not be
  // re-run either, since it already succeeded.
  const recoveredResult = recoverRun(db, run.id, {
    recoveredBy: 'operator',
    handlers: { ...handlers, mock_external_action: () => { notifyCalls++; return { status: 'sent' }; } },
  });

  assert.equal(recoveredResult.status, 'completed');
  assert.equal(fetchCalls, 1, 'fetch must not be re-executed on recovery');
  assert.equal(notifyCalls, 1, 'the claim already existed from the failed attempt, so the handler is never called again');

  const notifyStep = getRunSteps(db, run.id).find((s) => s.step_id === 'notify');
  assert.equal(notifyStep.status, 'succeeded');
  assert.equal(JSON.parse(notifyStep.output).idempotent_replay, true);

  const audit = auditRowsFor(db, run.id);
  assert.ok(audit.some((e) => e.event_type === 'failure' && e.step_id === 'notify'), 'the failure must be audited');
  assert.ok(
    audit.some((e) => e.event_type === 'retry_attempt' && e.status === 'confirmed' && e.payload.recovered === true),
    'the recovery retry must be audited as a manual, recovered attempt'
  );
  assert.equal(audit.filter((e) => e.event_type === 'final_result').length, 2, 'one final_result for the failure, one for the eventual completion');

  const claimCount = db
    .prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE run_id = ? AND step_id = ?')
    .get(run.id, 'notify').n;
  assert.equal(claimCount, 1, 'still exactly one claim row - recovery never inserted a second one');
});

test('recovering a run that is not failed is rejected', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });
  advanceRun(db, run.id);

  assert.throws(() => recoverRun(db, run.id), /not in a failed state/);
});

// ---------------------------------------------------------------------------
// Scenario 2: a duplicate retry attempt on an external action must not
// double-execute it, and that guarantee is visible in idempotency_keys.
// ---------------------------------------------------------------------------

test('a duplicate retry on a mock_external_action step never re-executes the action', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'charge',
      type: 'mock_external_action',
      inputs: {},
      config: { action_name: 'charge_card', mock_response: { status: 'charged' } },
      permissions: { tools: ['charge_card'] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  let actionCalls = 0;
  const handlers = {
    mock_external_action: () => {
      actionCalls++;
      if (actionCalls === 1) throw new Error('gateway timeout (but the charge may have gone through)');
      return { status: 'charged', attempt: actionCalls };
    },
  };

  const first = advanceRun(db, run.id, { handlers });
  assert.equal(first.status, 'failed');
  assert.equal(actionCalls, 1);

  // Simulate a DUPLICATE retry request - e.g. a flaky client re-sending the
  // same "please retry" call. The first confirmation resets the step to
  // 'pending'; a second one arriving right behind it has nothing left to
  // confirm (the step isn't 'failed' anymore) and is rejected outright -
  // that's the first layer of protection, independent of idempotency_keys.
  retryStep(db, run.id, 'charge', 'operator');
  assert.throws(
    () => retryStep(db, run.id, 'charge', 'operator'),
    /is not currently failed/,
    'a second, duplicate retry confirmation has nothing to confirm once the first already reset the step'
  );

  const second = advanceRun(db, run.id, { handlers });
  assert.equal(second.status, 'completed');
  assert.equal(actionCalls, 1, 'claimIdempotentAction found the existing claim, so the handler was never called a second time');

  // A redundant advanceRun call after the run has already completed - e.g.
  // a duplicated "execute" request - must also be a pure no-op.
  const third = advanceRun(db, run.id, { handlers });
  assert.equal(third.status, 'completed');
  assert.equal(actionCalls, 1, 'still never re-executed, even after a redundant execute call post-completion');

  const claimCount = db
    .prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE run_id = ? AND step_id = ?')
    .get(run.id, 'charge').n;
  assert.equal(claimCount, 1, 'exactly one idempotency_keys row, proving the UNIQUE(run_id, step_id) constraint was only ever satisfied once');

  const toolCallEvents = auditRowsFor(db, run.id).filter((e) => e.event_type === 'tool_call' && e.step_id === 'charge');
  assert.ok(toolCallEvents.some((e) => e.status === 'failure'));
  assert.ok(toolCallEvents.some((e) => e.status === 'success'));
});

// ---------------------------------------------------------------------------
// Scenario 3: approval pause + resume, with the decision itself audited.
// ---------------------------------------------------------------------------

test('an approval pause and resume is fully audited and explainable', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'approve_step',
      type: 'human_approval',
      inputs: {},
      config: { approvers: ['boss@example.com'], message: 'ok to proceed?' },
      permissions: { tools: [] },
    },
    { id: 'report', type: 'final_report', inputs: {}, config: { template: 'done' }, permissions: { tools: [] } },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  const paused = advanceRun(db, run.id);
  assert.equal(paused.status, 'waiting_approval');

  let audit = auditRowsFor(db, run.id);
  assert.ok(audit.some((e) => e.event_type === 'approval_requested' && e.step_id === 'approve_step'));

  approveStep(db, run.id, 'approve_step', 'boss@example.com');
  const completed = advanceRun(db, run.id);
  assert.equal(completed.status, 'completed');

  audit = auditRowsFor(db, run.id);
  const decisionEvent = audit.find((e) => e.event_type === 'approval_decision');
  assert.equal(decisionEvent.status, 'approved');
  assert.equal(decisionEvent.payload.approved_by, 'boss@example.com');

  const explanation = explainRun(db, run.id);
  assert.equal(explanation.status, 'completed');
  assert.ok(
    explanation.narrative.some((line) => line.includes('approve_step') && line.includes('approved by boss@example.com')),
    `narrative should describe the approval: ${JSON.stringify(explanation.narrative)}`
  );
});

// ---------------------------------------------------------------------------
// explainRun: plain-English narrative correctness for branching + skips
// (requirement 2), driven entirely by recorded audit_log payloads.
// ---------------------------------------------------------------------------

test('explainRun describes which branch was taken, the actual compared values, and why the other branch was skipped', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'flag', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'check',
      type: 'deterministic_condition',
      inputs: { flag: { from: 'intake', output: 'flag' } },
      config: { expression: "flag == 'go'", on_true: 'true_branch', on_false: 'false_branch' },
      permissions: { tools: [] },
    },
    { id: 'true_branch', type: 'final_report', inputs: {}, config: { template: 'took true branch' }, permissions: { tools: [] } },
    { id: 'false_branch', type: 'final_report', inputs: {}, config: { template: 'took false branch' }, permissions: { tools: [] } },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { flag: 'go' }, createdBy: 'tester' });

  const result = advanceRun(db, run.id);
  assert.equal(result.status, 'completed');

  const explanation = explainRun(db, run.id);
  assert.deepEqual(explanation.path_taken, ['intake', 'check', 'true_branch']);
  assert.deepEqual(explanation.skipped_steps, [
    { step_id: 'false_branch', reason: explanation.skipped_steps[0].reason },
  ]);
  assert.match(explanation.skipped_steps[0].reason, /check.*evaluated to true.*false_branch.*not taken/i);

  const conditionLine = explanation.narrative.find((line) => line.includes('"check"'));
  assert.match(conditionLine, /flag = "go"/);
  assert.match(conditionLine, /TRUE/);
  assert.match(conditionLine, /branch "true_branch"/);
});
