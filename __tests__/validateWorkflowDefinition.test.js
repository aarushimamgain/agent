const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateWorkflowDefinition } = require('../src/validation/validateWorkflowDefinition');

const validDefinition = require(path.join('..', 'examples', 'invoice-workflow.json'));

function withSteps(steps, overrides = {}) {
  return { name: 'test workflow', steps, ...overrides };
}

test('a known-good definition is valid', () => {
  const result = validateWorkflowDefinition(validDefinition);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('rejects an unknown step type', () => {
  const def = withSteps([
    { id: 'a', type: 'teleport', inputs: {}, config: {}, permissions: { tools: [] } },
  ]);
  const result = validateWorkflowDefinition(def);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[0].type'));
});

test('rejects a dangling input reference', () => {
  const def = withSteps([
    {
      id: 'a',
      type: 'document_retrieval',
      inputs: { doc: { from: 'does_not_exist', output: 'content' } },
      config: { source: 's3', query: 'q' },
      permissions: { tools: ['document_store.read'] },
    },
  ]);
  const result = validateWorkflowDefinition(def);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /dangling reference/.test(e.message)));
});

test('rejects a cycle in the step graph', () => {
  const def = withSteps([
    {
      id: 'a',
      type: 'document_retrieval',
      inputs: { x: { from: 'b', output: 'y' } },
      config: { source: 's3', query: 'q' },
      permissions: { tools: ['document_store.read'] },
    },
    {
      id: 'b',
      type: 'document_retrieval',
      inputs: { x: { from: 'a', output: 'y' } },
      config: { source: 's3', query: 'q' },
      permissions: { tools: ['document_store.read'] },
    },
  ]);
  const result = validateWorkflowDefinition(def);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Cycle detected/.test(e.message)));
});

test('rejects a human_approval step with no approvers', () => {
  const def = withSteps([
    {
      id: 'a',
      type: 'human_approval',
      inputs: {},
      config: { approvers: [], message: 'review please' },
      permissions: { tools: [] },
    },
  ]);
  const result = validateWorkflowDefinition(def);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[a].config.approvers'));
});

test('rejects a tool-calling step with no declared permissions', () => {
  const def = withSteps([
    {
      id: 'a',
      type: 'mock_external_action',
      inputs: {},
      config: { action_name: 'do_thing', mock_response: {} },
      permissions: { tools: [] },
    },
  ]);
  const result = validateWorkflowDefinition(def);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[a].permissions.tools'));
});

test('rejects duplicate step ids', () => {
  const def = withSteps([
    { id: 'a', type: 'structured_input', inputs: {}, config: { fields: [{ name: 'x', type: 'string' }] }, permissions: { tools: [] } },
    { id: 'a', type: 'final_report', inputs: {}, config: { template: 't' }, permissions: { tools: [] } },
  ]);
  const result = validateWorkflowDefinition(def);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /used more than once/.test(e.message)));
});

test('rejects an entry-point step that declares inputs', () => {
  const def = withSteps([
    {
      id: 'a',
      type: 'structured_input',
      inputs: { x: { from: 'a', output: 'y' } },
      config: { fields: [{ name: 'x', type: 'string' }] },
      permissions: { tools: [] },
    },
  ]);
  const result = validateWorkflowDefinition(def);
  assert.equal(result.valid, false);
});
