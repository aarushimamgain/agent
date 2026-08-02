// Shared by the seed scripts (scripts/seedExampleWorkflow.js,
// scripts/seedJobApplicationScreening.js) so both publish versions the
// exact same way: validate first (a seed script producing an invalid
// definition would be a bug worth catching immediately, not something to
// silently insert), then insert the immutable workflow_versions row, then
// optionally point the workflow's current_version_id at it - the same
// sequence the real POST /workflows/:id/versions route follows.
const crypto = require('crypto');
const { validateWorkflowDefinition } = require('../src/validation/validateWorkflowDefinition');

function publishVersion(db, workflowId, definition, { publish = true, createdBy = 'seed-script' } = {}) {
  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid) {
    throw new Error(`Seed definition "${definition.name}" is invalid: ${JSON.stringify(validation.errors)}`);
  }
  const latest = db.prepare('SELECT MAX(version_number) AS max_version FROM workflow_versions WHERE workflow_id = ?').get(workflowId);
  const versionNumber = (latest.max_version || 0) + 1;
  const versionId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO workflow_versions (id, workflow_id, version_number, definition, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(versionId, workflowId, versionNumber, JSON.stringify(definition), createdBy);
  if (publish) {
    db.prepare("UPDATE workflows SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?").run(versionId, workflowId);
  }
  return { versionId, versionNumber };
}

module.exports = { publishVersion };
