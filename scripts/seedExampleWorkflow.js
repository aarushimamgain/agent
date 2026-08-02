#!/usr/bin/env node
// Populates a fresh database with one example workflow (two published
// versions, so the diff view has something real to show) and a handful of
// completed/approved sample runs (so the run history and run detail
// screens aren't empty on first load). Purely a demo convenience - talks
// directly to the engine/db modules (this is a backend script, not an HTTP
// client), and is safe to run more than once: it skips seeding if a
// workflow with the same name already exists.
const crypto = require('crypto');
const { db } = require('../src/db');
const { createRun, advanceRun, approveStep } = require('../src/execution/engine');
const { publishVersion } = require('./seedHelpers');
const exampleDefinition = require('../examples/invoice-workflow.json');

function main() {
  const existing = db.prepare('SELECT * FROM workflows WHERE name = ?').get(exampleDefinition.name);
  if (existing) {
    console.log(`Workflow "${exampleDefinition.name}" already exists (id=${existing.id}) - nothing to seed.`);
    return;
  }

  const workflowId = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name, description, created_by) VALUES (?, ?, ?, ?)').run(
    workflowId,
    exampleDefinition.name,
    exampleDefinition.description || null,
    'seed-script'
  );
  console.log(`Created workflow "${exampleDefinition.name}" (${workflowId})`);

  const v1 = publishVersion(db, workflowId, exampleDefinition, { publish: false });
  console.log(`Published v${v1.versionNumber}`);

  // A second version with a couple of small, real differences, so the
  // version-diff screen has something meaningful to show immediately.
  const v2Definition = JSON.parse(JSON.stringify(exampleDefinition));
  v2Definition.steps.find((s) => s.id === 'extract_fields').config.model = 'gpt-4o';
  v2Definition.steps.find((s) => s.id === 'final_summary').config.template =
    'Invoice processed. Classification: {{classification}}. Extracted data: {{extracted}}.';
  const v2 = publishVersion(db, workflowId, v2Definition, { publish: true });
  console.log(`Published v${v2.versionNumber} (current)`);

  const sampleInputs = [
    { customer_email: 'alice@example.com', document_url: 'https://example.com/invoice-1.pdf' },
    { customer_email: 'bob@example.com', document_url: 'https://example.com/invoice-2.pdf' },
    { customer_email: 'carol@example.com', document_url: 'https://example.com/invoice-3.pdf' },
  ];
  for (const inputData of sampleInputs) {
    const run = createRun(db, { workflowId, workflowVersionId: v2.versionId, inputData, createdBy: 'seed-script' });
    let result = advanceRun(db, run.id);
    if (result.status === 'waiting_approval') {
      approveStep(db, run.id, result.stepId, 'finance-team@example.com');
      result = advanceRun(db, run.id);
    }
    console.log(`Run ${run.id}: ${result.status}`);
  }

  console.log('Seed complete.');
}

main();
