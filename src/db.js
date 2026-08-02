// Single, shared database connection for the whole server process.
// better-sqlite3 is synchronous (no connection pool, no async driver
// overhead) which is exactly what you want for a single-file local
// database - every route below can just call db.prepare(...).run(...)
// directly with no await, no pool exhaustion, no dangling connections to
// leak.
require('dotenv').config();
const { ensureDatabase } = require('./setupDatabase');

const db = ensureDatabase();

module.exports = { db };
