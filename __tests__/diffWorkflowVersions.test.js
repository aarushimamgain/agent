const test = require('node:test');
const assert = require('node:assert/strict');
const { diffWorkflowVersions } = require('../src/validation/diffWorkflowVersions');

function step(id, overrides = {}) {
  return {
    id,
    type: 'mock_external_action',
    inputs: {},
    config: { action_name: 'noop', mock_response: {} },
    permissions: { tools: ['some.tool'] },
    ...overrides,
  };
}

test('detects an added step', () => {
  const oldDef = { name: 'wf', steps: [step('a')] };
  const newDef = { name: 'wf', steps: [step('a'), step('b')] };
  const diff = diffWorkflowVersions(oldDef, newDef);

  assert.equal(diff.addedSteps.length, 1);
  assert.equal(diff.addedSteps[0].id, 'b');
  assert.equal(diff.removedSteps.length, 0);
  assert.equal(diff.modifiedSteps.length, 0);
  assert.deepEqual(diff.unchangedStepIds, ['a']);
});

test('detects a removed step', () => {
  const oldDef = { name: 'wf', steps: [step('a'), step('b')] };
  const newDef = { name: 'wf', steps: [step('a')] };
  const diff = diffWorkflowVersions(oldDef, newDef);

  assert.equal(diff.removedSteps.length, 1);
  assert.equal(diff.removedSteps[0].id, 'b');
});

test('detects a modified step and names the changed field', () => {
  const oldDef = { name: 'wf', steps: [step('a', { config: { action_name: 'noop', mock_response: {} } })] };
  const newDef = { name: 'wf', steps: [step('a', { config: { action_name: 'do_something_else', mock_response: {} } })] };
  const diff = diffWorkflowVersions(oldDef, newDef);

  assert.equal(diff.modifiedSteps.length, 1);
  assert.equal(diff.modifiedSteps[0].id, 'a');
  assert.equal(diff.modifiedSteps[0].changes[0].field, 'config');
});

test('key order inside config/inputs does not count as a change', () => {
  const oldDef = { name: 'wf', steps: [step('a', { config: { action_name: 'noop', mock_response: { a: 1, b: 2 } } })] };
  const newDef = { name: 'wf', steps: [step('a', { config: { mock_response: { b: 2, a: 1 }, action_name: 'noop' } })] };
  const diff = diffWorkflowVersions(oldDef, newDef);

  assert.equal(diff.modifiedSteps.length, 0);
  assert.deepEqual(diff.unchangedStepIds, ['a']);
});

test('detects workflow-level metadata changes', () => {
  const oldDef = { name: 'wf v1', description: 'old', steps: [step('a')] };
  const newDef = { name: 'wf v2', description: 'old', steps: [step('a')] };
  const diff = diffWorkflowVersions(oldDef, newDef);

  assert.equal(diff.metadataChanges.length, 1);
  assert.equal(diff.metadataChanges[0].field, 'name');
});

test('a step moved to a different array position with no other change is unchanged', () => {
  const oldDef = { name: 'wf', steps: [step('a'), step('b')] };
  const newDef = { name: 'wf', steps: [step('b'), step('a')] };
  const diff = diffWorkflowVersions(oldDef, newDef);

  assert.equal(diff.addedSteps.length, 0);
  assert.equal(diff.removedSteps.length, 0);
  assert.equal(diff.modifiedSteps.length, 0);
  assert.equal(diff.unchangedStepIds.length, 2);
});
