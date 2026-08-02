const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freshDb, publishDefinition } = require('./helpers/testHarness');
const { validateWorkflowDefinition } = require('../src/validation/validateWorkflowDefinition');
const {
  MAX_AUTO_RETRIES,
  createRun,
  advanceRun,
  approveStep,
  rejectStep,
  retryStep,
  cancelRun,
  resumeRun,
  getRun,
  getRunSteps,
} = require('../src/execution/engine');

// Every fixture definition below is checked against the real validator, so
// a typo in a test fixture fails loudly as "invalid definition" rather than
// producing a confusing engine-level error.
function definitionFor(steps, name = 'test workflow') {
  const definition = { name, steps };
  const result = validateWorkflowDefinition(definition);
  assert.equal(result.valid, true, `test fixture should be valid: ${JSON.stringify(result.errors)}`);
  return definition;
}

function stepById(db, runId, stepId) {
  return getRunSteps(db, runId).find((s) => s.step_id === stepId);
}

// ---------------------------------------------------------------------------
// Human approval: pause + resume via a separate call, including a genuine
// process-restart (a second, independent connection to the same file).
// ---------------------------------------------------------------------------

test('human_approval pauses the run and persists paused state', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'amount', type: 'number' }] }, permissions: { tools: [] } },
    {
      id: 'approve_step',
      type: 'human_approval',
      inputs: { amount: { from: 'intake', output: 'amount' } },
      config: { approvers: ['boss@example.com'], message: 'approve?' },
      permissions: { tools: [] },
    },
    {
      id: 'report',
      type: 'final_report',
      inputs: { decision: { from: 'approve_step', output: 'decision' } },
      config: { template: 'Decision: {{decision}}' },
      permissions: { tools: [] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { amount: 100 }, createdBy: 'tester' });

  const result = advanceRun(db, run.id);

  assert.equal(result.status, 'waiting_approval');
  assert.equal(result.stepId, 'approve_step');
  assert.equal(getRun(db, run.id).status, 'waiting_approval');
  assert.equal(stepById(db, run.id, 'approve_step').status, 'paused');
  assert.equal(stepById(db, run.id, 'report').status, 'pending'); // never reached yet
});

test('approving a paused step and calling execute again from a brand-new connection completes the run', () => {
  const dbPath = path.join(os.tmpdir(), `engine-test-${crypto.randomUUID()}.db`);
  try {
    const dbA = freshDb(dbPath);
    const definition = definitionFor([
      { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'amount', type: 'number' }] }, permissions: { tools: [] } },
      {
        id: 'approve_step',
        type: 'human_approval',
        inputs: {},
        config: { approvers: ['boss@example.com'], message: 'approve?' },
        permissions: { tools: [] },
      },
      {
        id: 'report',
        type: 'final_report',
        inputs: { decision: { from: 'approve_step', output: 'decision' } },
        config: { template: 'Decision: {{decision}}' },
        permissions: { tools: [] },
      },
    ]);
    const { workflowId, workflowVersionId } = publishDefinition(dbA, definition);
    const run = createRun(dbA, { workflowId, workflowVersionId, inputData: { amount: 100 }, createdBy: 'tester' });
    advanceRun(dbA, run.id);
    dbA.close(); // simulates the Node process exiting entirely

    // A completely independent connection - and in a real deployment, a
    // completely independent process - picks the run back up purely from
    // what's on disk.
    const dbB = freshDb(dbPath);
    approveStep(dbB, run.id, 'approve_step', 'boss@example.com');
    const result = advanceRun(dbB, run.id);

    assert.equal(result.status, 'completed');
    assert.equal(JSON.parse(getRun(dbB, run.id).final_output).report, 'Decision: approved');
    dbB.close();
  } finally {
    // Best-effort cleanup: on Windows a just-closed file can stay briefly
    // locked (AV scan, delayed handle release), which isn't something this
    // test's correctness depends on.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        // ignore
      }
    }
  }
});

test('rejecting a paused step fails the run without running later steps', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'approve_step',
      type: 'human_approval',
      inputs: {},
      config: { approvers: ['boss@example.com'], message: 'approve?' },
      permissions: { tools: [] },
    },
    { id: 'report', type: 'final_report', inputs: {}, config: { template: 'done' }, permissions: { tools: [] } },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  advanceRun(db, run.id);
  rejectStep(db, run.id, 'approve_step', 'boss@example.com');
  const result = advanceRun(db, run.id);

  assert.equal(result.status, 'failed');
  assert.equal(stepById(db, run.id, 'approve_step').status, 'failed');
  assert.equal(stepById(db, run.id, 'report').status, 'pending'); // never attempted
});

// ---------------------------------------------------------------------------
// Cancellation mid-execution + resume without repeating completed steps
// ---------------------------------------------------------------------------

test('a cancelled run stops advancing and does not repeat already-succeeded steps on resume', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'step_a',
      type: 'document_retrieval',
      inputs: {},
      config: { source: 's3', query: 'q' },
      permissions: { tools: ['document_store.read'] },
    },
    {
      id: 'step_b',
      type: 'document_retrieval',
      inputs: {},
      config: { source: 's3', query: 'q2' },
      permissions: { tools: ['document_store.read'] },
    },
    {
      id: 'step_c',
      type: 'document_retrieval',
      inputs: {},
      config: { source: 's3', query: 'q3' },
      permissions: { tools: ['document_store.read'] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  let callCount = 0;
  const handlers = {
    document_retrieval: (inputs, config) => {
      callCount++;
      return { content: `fetched-${config.query}` };
    },
  };

  // Advance exactly two steps (intake + step_a), then cancel.
  advanceRun(db, run.id, { handlers, maxSteps: 2 });
  cancelRun(db, run.id, 'operator');

  const cancelledResult = advanceRun(db, run.id, { handlers });
  assert.equal(cancelledResult.status, 'cancelled');
  assert.equal(callCount, 1); // only step_a's real handler has run so far

  assert.equal(stepById(db, run.id, 'step_a').status, 'succeeded');
  assert.equal(stepById(db, run.id, 'step_b').status, 'pending');
  assert.equal(stepById(db, run.id, 'step_c').status, 'pending');

  resumeRun(db, run.id, 'operator');
  const finalResult = advanceRun(db, run.id, { handlers });

  assert.equal(finalResult.status, 'completed');
  assert.equal(callCount, 3); // step_a was NOT re-run; only step_b and step_c added calls
  assert.equal(stepById(db, run.id, 'step_a').status, 'succeeded');
  assert.equal(stepById(db, run.id, 'step_b').status, 'succeeded');
  assert.equal(stepById(db, run.id, 'step_c').status, 'succeeded');
});

test('cancel is rejected once a run has already reached a terminal state', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });
  advanceRun(db, run.id);

  assert.equal(getRun(db, run.id).status, 'completed');
  assert.throws(() => cancelRun(db, run.id), /terminal state/);
});

// ---------------------------------------------------------------------------
// Idempotency: the mock action function itself is invoked at most once per
// (run, step), even across a failure + manual retry, because the
// idempotency_keys claim happens before the action runs.
// ---------------------------------------------------------------------------

test('a mock_external_action is never invoked twice, even after a failure requires manual retry', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
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

  let callCount = 0;
  const handlers = {
    // Simulates a real external call that actually happened, followed by a
    // crash/error before the engine could record success.
    mock_external_action: () => {
      callCount++;
      if (callCount === 1) throw new Error('simulated crash after the real action already fired');
      return { status: 'queued', attempt: callCount };
    },
  };

  const firstAttempt = advanceRun(db, run.id, { handlers });
  assert.equal(firstAttempt.status, 'failed');
  assert.equal(callCount, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE run_id = ? AND step_id = ?').get(run.id, 'notify').n,
    1
  );

  retryStep(db, run.id, 'notify', 'operator');
  const secondAttempt = advanceRun(db, run.id, { handlers });

  assert.equal(secondAttempt.status, 'completed');
  assert.equal(callCount, 1, 'the mock action function must not be called a second time');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE run_id = ? AND step_id = ?').get(run.id, 'notify').n,
    1,
    'still exactly one idempotency_keys row - the UNIQUE(run_id, step_id) constraint was never even challenged a second time because the claim check found it first'
  );
  const notifyStep = stepById(db, run.id, 'notify');
  assert.equal(notifyStep.status, 'succeeded');
  assert.equal(JSON.parse(notifyStep.output).idempotent_replay, true);
});

// ---------------------------------------------------------------------------
// Retry logic: retryable step types get automatic retries up to the cap;
// mock_external_action (a side-effecting type) gets none.
// ---------------------------------------------------------------------------

test('a retryable step type is retried automatically and can still succeed', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'extract',
      type: 'ai_extraction',
      inputs: {},
      config: { model: 'mock-model', output_fields: ['x'] },
      permissions: { tools: ['llm.invoke'] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  let callCount = 0;
  const handlers = {
    ai_extraction: () => {
      callCount++;
      if (callCount < 3) throw new Error('transient failure');
      return { fields: { x: 'ok' } };
    },
  };

  const result = advanceRun(db, run.id, { handlers });

  assert.equal(result.status, 'completed');
  assert.equal(callCount, 3);
  const extractStep = stepById(db, run.id, 'extract');
  assert.equal(extractStep.status, 'succeeded');
  assert.equal(extractStep.retry_count, 2);
});

test('a retryable step fails the run once MAX_AUTO_RETRIES is exhausted', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'extract',
      type: 'ai_extraction',
      inputs: {},
      config: { model: 'mock-model', output_fields: ['x'] },
      permissions: { tools: ['llm.invoke'] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  let callCount = 0;
  const handlers = {
    ai_extraction: () => {
      callCount++;
      throw new Error('always fails');
    },
  };

  const result = advanceRun(db, run.id, { handlers });

  assert.equal(result.status, 'failed');
  assert.equal(callCount, MAX_AUTO_RETRIES);
  assert.equal(stepById(db, run.id, 'extract').status, 'failed');
});

test('mock_external_action is never auto-retried - one failure halts the run for manual confirmation', () => {
  const db = freshDb();
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'notify',
      type: 'mock_external_action',
      inputs: {},
      config: { action_name: 'send_email', mock_response: {} },
      permissions: { tools: ['send_email'] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  let callCount = 0;
  const handlers = {
    mock_external_action: () => {
      callCount++;
      throw new Error('always fails');
    },
  };

  const result = advanceRun(db, run.id, { handlers });

  assert.equal(result.status, 'failed');
  assert.equal(callCount, 1, 'no automatic retries for a side-effecting step type');
  assert.equal(stepById(db, run.id, 'notify').retry_count, 0);

  // Confirmed manually, it can still be attempted again.
  retryStep(db, run.id, 'notify', 'operator');
  const retried = advanceRun(db, run.id, {
    handlers: { mock_external_action: () => ({ status: 'sent' }) },
  });
  assert.equal(retried.status, 'completed');
});

// ---------------------------------------------------------------------------
// Permission enforcement: a step whose declared tools don't include the one
// it actually needs is rejected before its handler ever runs.
// ---------------------------------------------------------------------------

test('a step is rejected at execution time if its permissions do not include the tool it needs', () => {
  const db = freshDb();
  // validateWorkflowDefinition only checks that permissions.tools is
  // non-empty for a tool-calling step type, not that it names the RIGHT
  // tool - so this fixture passes validation but should still be rejected
  // by the engine's own permission check.
  const definition = definitionFor([
    { id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'placeholder', type: 'string' }] }, permissions: { tools: [] } },
    {
      id: 'extract',
      type: 'ai_extraction',
      inputs: {},
      config: { model: 'mock-model', output_fields: ['x'] },
      permissions: { tools: ['some.unrelated.tool'] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { placeholder: 'x' }, createdBy: 'tester' });

  let handlerCalled = false;
  const handlers = { ai_extraction: () => { handlerCalled = true; return { fields: {} }; } };

  const result = advanceRun(db, run.id, { handlers });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /not declared in its permissions/);
  assert.equal(handlerCalled, false, 'the handler must never be called once permission is denied');

  const auditRow = db
    .prepare("SELECT * FROM audit_log WHERE run_id = ? AND step_id = 'extract' AND event_type = 'ai_call' AND status = 'denied'")
    .get(run.id);
  assert.ok(auditRow, 'permission denial should be recorded in audit_log');
});

// ---------------------------------------------------------------------------
// Branching: deterministic_condition skips the untaken branch, and anything
// depending on the untaken branch's output is skipped too.
// ---------------------------------------------------------------------------

test('deterministic_condition skips the untaken branch and cascades the skip downstream', () => {
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
    {
      id: 'depends_on_false_branch',
      type: 'final_report',
      inputs: { x: { from: 'false_branch', output: 'report' } },
      config: { template: 'downstream of false branch' },
      permissions: { tools: [] },
    },
  ]);
  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, { workflowId, workflowVersionId, inputData: { flag: 'go' }, createdBy: 'tester' });

  const result = advanceRun(db, run.id);

  assert.equal(result.status, 'completed');
  assert.equal(stepById(db, run.id, 'check').status, 'succeeded');
  assert.equal(stepById(db, run.id, 'true_branch').status, 'succeeded');
  assert.equal(stepById(db, run.id, 'false_branch').status, 'skipped');
  assert.equal(stepById(db, run.id, 'depends_on_false_branch').status, 'skipped');
});

// ---------------------------------------------------------------------------
// End-to-end smoke test against the full example definition shipped in
// examples/invoice-workflow.json, using the real (deterministic) mocks -
// proves the whole thing runs with no AI API keys and no external services.
// ---------------------------------------------------------------------------

test('the full invoice-workflow example runs end to end with the real mocks', () => {
  const db = freshDb();
  const definition = require('../examples/invoice-workflow.json');
  assert.equal(validateWorkflowDefinition(definition).valid, true);

  const { workflowId, workflowVersionId } = publishDefinition(db, definition);
  const run = createRun(db, {
    workflowId,
    workflowVersionId,
    inputData: { customer_email: 'a@example.com', document_url: 'https://example.com/invoice.pdf' },
    createdBy: 'tester',
  });

  let result = advanceRun(db, run.id);
  if (result.status === 'waiting_approval') {
    approveStep(db, run.id, result.stepId, 'finance-team@example.com');
    result = advanceRun(db, run.id);
  }

  assert.equal(result.status, 'completed');

  const steps = getRunSteps(db, run.id);
  // Whichever branch check_risk took, exactly one of the two mutually
  // exclusive downstream steps actually ran and the other was skipped.
  const requestApproval = steps.find((s) => s.step_id === 'request_approval');
  const notifyDownstream = steps.find((s) => s.step_id === 'notify_downstream');
  const outcomes = [requestApproval.status, notifyDownstream.status].sort();
  assert.deepEqual(outcomes, ['skipped', 'succeeded']);

  assert.equal(stepById(db, run.id, 'final_summary').status, 'succeeded');
  assert.ok(JSON.parse(getRun(db, run.id).final_output).report.includes('Processed invoice'));
});
