#!/usr/bin/env node
// Populates a fresh database with the "Job Application Screening" demo
// workflow: two published versions (a real diff between them) and four
// runs, each left in a different, deliberately-chosen state so the app has
// something interesting to look at in every screen immediately after
// `npm run seed` - no manual clicking required before a demo starts.
//
// The four run states are produced by DEPENDENCY-INJECTING the
// ai_classification (and, for the failed run, mock_external_action)
// handler passed to advanceRun() - the same override mechanism
// __tests__/engine.test.js and __tests__/observability.test.js use to force
// a specific outcome deterministically, rather than hoping the real mock's
// input-hash happens to land on the branch we want (see
// src/execution/mocks.js: mockAiClassification's category is a hash of its
// inputs, so which candidate email/resume URL you pick would otherwise
// decide the branch by accident). Every OTHER step still runs through the
// real default mocks - only the one decision each run needs to hit a
// specific state is overridden.
//
// Safe to run more than once: it skips seeding if a workflow with this
// name already exists.
const crypto = require('crypto');
const { db } = require('../src/db');
const { createRun, advanceRun, approveStep } = require('../src/execution/engine');
const { defaultHandlers } = require('../src/execution/mocks');
const { publishVersion } = require('./seedHelpers');
const v1Definition = require('../examples/job-application-screening.json');

// Forces classify_candidate's output without touching any other mock -
// document retrieval and extraction still run for real (against the mocks),
// so the audit trail and explanation for these runs look exactly like a
// real run that happened to classify this way.
function withForcedClassification(category, model) {
  return {
    ...defaultHandlers,
    ai_classification: (resolvedInputs, config) => ({ category, model: model || config.model, mock: true }),
  };
}

// For the one run that needs to end up 'failed': mock_external_action
// isn't auto-retryable (see src/schema/stepTypes.js), so a single thrown
// error here halts the run immediately - a realistic stand-in for "the ATS
// webhook timed out".
function withForcedClassificationAndFailingAction(category, model, errorMessage) {
  return {
    ...withForcedClassification(category, model),
    mock_external_action: () => {
      throw new Error(errorMessage);
    },
  };
}

function main() {
  const existing = db.prepare('SELECT * FROM workflows WHERE name = ?').get(v1Definition.name);
  if (existing) {
    console.log(`Workflow "${v1Definition.name}" already exists (id=${existing.id}) - nothing to seed.`);
    return;
  }

  const workflowId = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name, description, created_by) VALUES (?, ?, ?, ?)').run(
    workflowId,
    v1Definition.name,
    v1Definition.description || null,
    'seed-script'
  );
  console.log(`Created workflow "${v1Definition.name}" (${workflowId})`);

  const v1 = publishVersion(db, workflowId, v1Definition, { publish: false });
  console.log(`Published v${v1.versionNumber}`);

  // v2: a real, three-step diff - a model upgrade, a reworded approval
  // message, and an enriched mock response - so the "Versions & Diff"
  // screen has genuine modified-step changes to show, not a cosmetic no-op.
  const v2Definition = JSON.parse(JSON.stringify(v1Definition));
  v2Definition.steps.find((s) => s.id === 'extract_candidate_info').config.model = 'gpt-4o';
  v2Definition.steps.find((s) => s.id === 'human_review').config.message =
    "Please confirm this candidate should advance to the interview stage.";
  v2Definition.steps.find((s) => s.id === 'notify_ats').config.mock_response = {
    status: 'recorded',
    queued_for_onboarding: true,
  };
  const v2 = publishVersion(db, workflowId, v2Definition, { publish: true });
  console.log(`Published v${v2.versionNumber} (current)`);

  function startRun(inputData, handlers) {
    const run = createRun(db, { workflowId, workflowVersionId: v2.versionId, inputData, createdBy: 'careers-portal' });
    const result = advanceRun(db, run.id, { handlers });
    return { runId: run.id, status: result.status };
  }

  // 1. Strong fit -> skips human review entirely, auto-notifies the ATS,
  // completes on its own. Demonstrates the "auto" branch of the condition.
  const run1 = startRun(
    { candidate_email: 'dana@example.com', resume_url: 'https://example.com/resumes/dana.pdf' },
    withForcedClassification('strong_fit', 'gpt-4o')
  );
  console.log(`Run ${run1.runId} (strong fit, auto-cleared): ${run1.status}`);

  // 2. Needs review -> pauses for human_review -> approved -> completes.
  // Demonstrates the full happy path through a human approval.
  const run2 = startRun(
    { candidate_email: 'erin@example.com', resume_url: 'https://example.com/resumes/erin.pdf' },
    withForcedClassification('needs_review', 'gpt-4o')
  );
  approveStep(db, run2.runId, 'human_review', 'hiring-manager@example.com');
  const run2Final = advanceRun(db, run2.runId);
  console.log(`Run ${run2.runId} (needs review, approved): ${run2Final.status}`);

  // 3. Needs review -> pauses for human_review -> left untouched, so the
  // demo can approve/reject it live. This is the "paused on approval" state.
  const run3 = startRun(
    { candidate_email: 'frank@example.com', resume_url: 'https://example.com/resumes/frank.pdf' },
    withForcedClassification('needs_review', 'gpt-4o')
  );
  console.log(`Run ${run3.runId} (needs review, awaiting decision): ${run3.status}`);

  // 4. Strong fit -> skips human review -> notify_ats's mock throws ->
  // fails immediately (not auto-retryable). This is the "failed" state,
  // left as-is so the demo can trigger POST /runs/:id/recover live.
  const run4 = startRun(
    { candidate_email: 'grace@example.com', resume_url: 'https://example.com/resumes/grace.pdf' },
    withForcedClassificationAndFailingAction('strong_fit', 'gpt-4o', 'ATS webhook timed out after 30s')
  );
  console.log(`Run ${run4.runId} (failed - ATS webhook timeout): ${run4.status}`);

  console.log('Seed complete: 2 versions, 4 runs (completed x2, waiting_approval, failed).');
}

main();
