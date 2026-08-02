// Express routes for creating workflows, publishing new (immutable)
// versions, validating a definition before publishing, and diffing two
// existing versions. Kept intentionally thin: each route does
// input-checking + a couple of synchronous better-sqlite3 calls + an
// audit_log insert. Any real business logic (the validator, the differ)
// lives in src/validation/*, not here, so it stays unit-testable without
// an Express app or a database.
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const { validateWorkflowDefinition } = require('../validation/validateWorkflowDefinition');
const { diffWorkflowVersions } = require('../validation/diffWorkflowVersions');
const { recordAudit: recordAuditEntry } = require('../auditLog');

const router = express.Router();

// Thin wrapper so call sites below don't have to pass `db` explicitly each time.
function recordAudit(args) {
  recordAuditEntry(db, args);
}

// Validate a definition without persisting anything. Lets an editor UI
// show errors before the user tries to publish.
router.post('/validate', (req, res) => {
  const result = validateWorkflowDefinition(req.body);
  res.status(result.valid ? 200 : 422).json(result);
});

// --- read endpoints for the frontend (list/detail views) ---
// These are plain SELECTs with no business logic, added so the React app
// has something to fetch: it never touches SQLite itself, per the "backend
// is the only thing that touches SQLite directly" constraint.

// All workflows, most recently updated first.
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all());
});

// A single workflow's metadata (name, description, current_version_id).
router.get('/:workflowId', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.workflowId);
  if (!row) return res.status(404).json({ error: 'Workflow not found' });
  res.json(row);
});

// Version summaries for a workflow (no `definition` payload - that's what
// keeps this list cheap to fetch for a version-history sidebar). Fetch a
// specific version below to get its full definition.
router.get('/:workflowId/versions', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, workflow_id, version_number, created_by, created_at
       FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC`
    )
    .all(req.params.workflowId);
  res.json(rows);
});

// A single version, definition included - used to render the step graph
// and to pre-fill a "rerun" form's structured_input fields.
router.get('/:workflowId/versions/:versionNumber', (req, res) => {
  const row = db
    .prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version_number = ?')
    .get(req.params.workflowId, Number(req.params.versionNumber));
  if (!row) return res.status(404).json({ error: 'Version not found' });
  res.json({ ...row, definition: JSON.parse(row.definition) });
});

// Create a new workflow (metadata only - no version/definition yet).
router.post('/', (req, res) => {
  const { name, description, created_by } = req.body;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name, description, created_by) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    description || null,
    created_by || null
  );

  recordAudit({ eventType: 'workflow_created', status: 'created', payload: { workflow_id: id, name }, actor: created_by });
  res.status(201).json(db.prepare('SELECT * FROM workflows WHERE id = ?').get(id));
});

// Publish a new version of a workflow: validate the definition, insert an
// immutable workflow_versions row, and (optionally) point the parent
// workflow's current_version_id at it.
//
// Computing the next version_number ("1 + the highest existing
// version_number for this workflow") and inserting the new row is wrapped
// in a single db.transaction(). Because better-sqlite3 is synchronous and
// this whole callback runs as one SQLite transaction, there is no race
// window here even under concurrent requests - unlike a multi-round-trip
// database, nothing else can interleave a write between the SELECT and
// the INSERT.
router.post('/:workflowId/versions', (req, res) => {
  const { workflowId } = req.params;
  const { definition, created_by, publish } = req.body;

  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid) {
    return res.status(422).json({ error: 'Workflow definition is invalid', details: validation.errors });
  }

  const workflow = db.prepare('SELECT id FROM workflows WHERE id = ?').get(workflowId);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }

  const publishVersion = db.transaction(() => {
    const latest = db
      .prepare('SELECT MAX(version_number) AS max_version FROM workflow_versions WHERE workflow_id = ?')
      .get(workflowId);
    const nextVersionNumber = (latest.max_version || 0) + 1;

    const versionId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, definition, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(versionId, workflowId, nextVersionNumber, JSON.stringify(definition), created_by || null);

    if (publish) {
      db.prepare('UPDATE workflows SET current_version_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
        versionId,
        workflowId
      );
    }

    return { versionId, nextVersionNumber };
  });

  const { versionId, nextVersionNumber } = publishVersion();

  recordAudit({
    eventType: 'version_created',
    status: 'created',
    payload: { workflow_id: workflowId, workflow_version_id: versionId, version_number: nextVersionNumber },
    actor: created_by,
  });
  if (publish) {
    recordAudit({
      eventType: 'version_published',
      status: 'published',
      payload: { workflow_id: workflowId, workflow_version_id: versionId, version_number: nextVersionNumber },
      actor: created_by,
    });
  }

  const versionRow = db.prepare('SELECT * FROM workflow_versions WHERE id = ?').get(versionId);
  res.status(201).json({ ...versionRow, definition: JSON.parse(versionRow.definition) });
});

// Diff two versions of the same workflow by their version_number.
router.get('/:workflowId/versions/:fromVersion/diff/:toVersion', (req, res) => {
  const { workflowId, fromVersion, toVersion } = req.params;

  const getVersion = db.prepare(
    'SELECT definition FROM workflow_versions WHERE workflow_id = ? AND version_number = ?'
  );
  const fromRow = getVersion.get(workflowId, Number(fromVersion));
  const toRow = getVersion.get(workflowId, Number(toVersion));

  if (!fromRow || !toRow) {
    return res.status(404).json({ error: 'One or both versions were not found for this workflow.' });
  }

  res.json(diffWorkflowVersions(JSON.parse(fromRow.definition), JSON.parse(toRow.definition)));
});

module.exports = router;
