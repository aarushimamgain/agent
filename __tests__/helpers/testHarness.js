// Shared setup for engine tests: a real (not mocked) SQLite database with
// the actual schema applied, plus a shortcut for getting a definition
// published as a workflow_version the way the /workflows routes would.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'migrations', 'schema.sql');

function freshDb(dbPath = ':memory:') {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

// Inserts a workflow + a single published version, bypassing the HTTP
// layer, and returns the ids createRun() needs.
function publishDefinition(db, definition, { workflowName = 'test workflow' } = {}) {
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name) VALUES (?, ?)').run(workflowId, workflowName);
  db.prepare('INSERT INTO workflow_versions (id, workflow_id, version_number, definition) VALUES (?, ?, 1, ?)').run(
    versionId,
    workflowId,
    JSON.stringify(definition)
  );
  db.prepare('UPDATE workflows SET current_version_id = ? WHERE id = ?').run(versionId, workflowId);
  return { workflowId, workflowVersionId: versionId };
}

module.exports = { freshDb, publishDefinition };
