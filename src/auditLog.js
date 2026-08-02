// Shared by src/routes/workflows.js and src/execution/engine.js so every
// write to audit_log goes through one place with one row shape. See the
// audit_log table comment in migrations/schema.sql for the full field-by-
// field rationale (why run_id/step_id are loose references, why event_type
// is a closed vocabulary, why payload exists).
const crypto = require('crypto');

function recordAudit(db, { runId, stepId, eventType, status, payload, actor }) {
  db.prepare(
    `INSERT INTO audit_log (id, run_id, step_id, event_type, status, payload, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    runId || null,
    stepId || null,
    eventType,
    status || 'info',
    payload !== undefined && payload !== null ? JSON.stringify(payload) : null,
    actor || 'system'
  );
}

module.exports = { recordAudit };
