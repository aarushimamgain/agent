// Opens (creating if necessary) the SQLite database file and applies
// migrations/schema.sql. This is the one function that turns "an empty
// checkout" into "a working database", which is what lets the whole
// project run with just `npm install && npm start` - no separate "create
// the database" step for a human to remember.
//
// schema.sql is written entirely with CREATE TABLE/INDEX IF NOT EXISTS, so
// re-running it against an already-set-up database is always a safe
// no-op. That means this function doesn't need separate "first run" vs
// "later run" code paths - it always ensures the file exists, always
// applies the schema, and just logs which case it was for the operator's
// benefit.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'workflow.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'migrations', 'schema.sql');

function ensureDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  const alreadyExisted = fs.existsSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Off by default in SQLite for backwards-compatibility reasons; we rely
  // on foreign keys (ON DELETE CASCADE, REFERENCES checks) throughout the
  // schema, so this must be set on every connection, not just at setup
  // time.
  db.pragma('foreign_keys = ON');
  // WAL lets readers and a writer proceed concurrently instead of
  // exclusive-locking the whole file per write - a sensible default for a
  // server process rather than a one-off script.
  db.pragma('journal_mode = WAL');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  console.log(alreadyExisted ? `Using existing database at ${dbPath}` : `Created new database at ${dbPath}`);
  return db;
}

module.exports = { ensureDatabase, DEFAULT_DB_PATH };
