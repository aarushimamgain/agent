// Compares two workflow_versions.definition JSON blobs (e.g. version 2 vs
// version 3 of the same workflow) and returns a structured description of
// what changed, so a UI can render "3 steps added, 1 modified" instead of
// a raw JSON diff.
//
// We diff by step `id`, not by array position - a step moved from index 0
// to index 2 with nothing else changed should show up as "unchanged",
// not as "removed + added". This is the only sane way to diff a list that
// represents a graph rather than an ordered sequence.
const { deepEqual } = require('./deepEqual');

// The step fields we consider meaningful for the diff. `id` and `type`
// changing at the same time would really be "remove + add", but since we
// key by id, a changed `type` shows up as a modified field on that id -
// which is exactly what a workflow author needs to see ("step X used to
// be an ai_classification step, now it's a human_approval step").
const COMPARED_FIELDS = ['type', 'inputs', 'config', 'permissions'];

function diffSteps(oldStep, newStep) {
  const changes = [];
  for (const field of COMPARED_FIELDS) {
    if (!deepEqual(oldStep[field], newStep[field])) {
      changes.push({ field, from: oldStep[field], to: newStep[field] });
    }
  }
  return changes;
}

function diffWorkflowVersions(oldDefinition, newDefinition) {
  const oldSteps = new Map((oldDefinition.steps || []).map((s) => [s.id, s]));
  const newSteps = new Map((newDefinition.steps || []).map((s) => [s.id, s]));

  const addedSteps = [];
  const removedSteps = [];
  const modifiedSteps = [];
  const unchangedStepIds = [];

  for (const [id, newStep] of newSteps) {
    if (!oldSteps.has(id)) {
      addedSteps.push(newStep);
      continue;
    }
    const changes = diffSteps(oldSteps.get(id), newStep);
    if (changes.length > 0) {
      modifiedSteps.push({ id, changes });
    } else {
      unchangedStepIds.push(id);
    }
  }

  for (const [id, oldStep] of oldSteps) {
    if (!newSteps.has(id)) {
      removedSteps.push(oldStep);
    }
  }

  const metadataChanges = [];
  for (const field of ['name', 'description']) {
    if (!deepEqual(oldDefinition[field], newDefinition[field])) {
      metadataChanges.push({ field, from: oldDefinition[field], to: newDefinition[field] });
    }
  }

  return { metadataChanges, addedSteps, removedSteps, modifiedSteps, unchangedStepIds };
}

module.exports = { diffWorkflowVersions };
