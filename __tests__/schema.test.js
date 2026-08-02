// Exercises migrations/schema.sql directly against an in-memory SQLite
// database (no file on disk, no server). This catches SQL typos and
// confirms the specific database-level guarantees the platform depends on:
// foreign keys actually cascade, and the UNIQUE constraints we rely on for
// correctness actually exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'schema.sql'), 'utf8'));
  return db;
}

test('schema.sql creates all six tables', () => {
  const db = freshDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    'audit_log',
    'idempotency_keys',
    'run_steps',
    'runs',
    'workflow_versions',
    'workflows',
  ]);
});

test('schema.sql is safe to re-run against an already-migrated database', () => {
  const db = freshDb();
  assert.doesNotThrow(() => db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'schema.sql'), 'utf8')));
});

test('deleting a workflow cascades to its versions', () => {
  const db = freshDb();
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name) VALUES (?, ?)').run(workflowId, 'wf');
  db.prepare(
    'INSERT INTO workflow_versions (id, workflow_id, version_number, definition) VALUES (?, ?, 1, ?)'
  ).run(versionId, workflowId, '{}');

  db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get().n, 0);
});

test('workflow_versions rejects a duplicate version_number for the same workflow', () => {
  const db = freshDb();
  const workflowId = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name) VALUES (?, ?)').run(workflowId, 'wf');
  db.prepare(
    'INSERT INTO workflow_versions (id, workflow_id, version_number, definition) VALUES (?, ?, 1, ?)'
  ).run(crypto.randomUUID(), workflowId, '{}');

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO workflow_versions (id, workflow_id, version_number, definition) VALUES (?, ?, 1, ?)')
        .run(crypto.randomUUID(), workflowId, '{}'),
    /UNIQUE constraint failed/
  );
});

test('idempotency_keys rejects a duplicate (run_id, step_id) pair', () => {
  const db = freshDb();
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

  db.prepare('INSERT INTO idempotency_keys (id, run_id, step_id, action_name) VALUES (?, ?, ?, ?)').run(
    crypto.randomUUID(),
    runId,
    'notify_downstream',
    'send_email'
  );

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO idempotency_keys (id, run_id, step_id, action_name) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), runId, 'notify_downstream', 'send_email'),
    /UNIQUE constraint failed/
  );
});
