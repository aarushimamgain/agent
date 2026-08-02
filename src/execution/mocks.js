// MOCK STUBS - stand-ins for the three step types that would otherwise need
// a real AI API key or a real external system: ai_extraction,
// ai_classification, and mock_external_action. document_retrieval is
// stubbed too (there's no real document store in this foundation either),
// though the platform's naming only calls out the first three explicitly.
//
// Every function here is a pure, deterministic function of its inputs: the
// same (resolvedInputs, config) always produces the same output, and
// nothing here makes a network call, reads a clock, or uses randomness.
// That determinism is deliberate - it's what makes the engine's tests
// reproducible, and it's also what makes crash-recovery of
// mock_external_action forgiving (see the design note in engine.js): even
// if we lost track of whether a mocked action already ran, recomputing it
// gives the identical result. A REAL external action would not have this
// property, which is exactly why idempotency_keys exists - don't rely on
// "just recompute it" outside of mocks.
//
// These are intentionally simple hand-rolled stand-ins, not a real model
// or HTTP client - swapping in a real implementation later means replacing
// the functions in this file, not touching the engine.

// Deterministic, non-cryptographic string hash (sum-then-multiply), used
// only to turn arbitrary input text into a stable-looking "made up" value.
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(hash, 31) + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// MOCK: stands in for reading a document/record from a real store.
function mockDocumentRetrieval(resolvedInputs, config) {
  return {
    content: `[MOCK DOCUMENT] source=${config.source} query=${config.query} inputs=${JSON.stringify(resolvedInputs)}`,
    mock: true,
  };
}

// MOCK: stands in for calling a real model to pull structured fields out of
// text. Gives every configured output_field a stable, made-up value tied
// to a hash of its inputs, so re-running with the same inputs always
// yields the same "extraction".
function mockAiExtraction(resolvedInputs, config) {
  const hash = hashString(JSON.stringify(resolvedInputs));
  const fields = {};
  for (const fieldName of config.output_fields) {
    fields[fieldName] = `${fieldName}-${hash}`;
  }
  return { fields, model: config.model, mock: true };
}

// MOCK: stands in for calling a real model to classify input into one of
// config.categories. The category chosen is a deterministic function of
// the input hash, so it's stable across retries but still varies with
// different input data.
function mockAiClassification(resolvedInputs, config) {
  const hash = hashString(JSON.stringify(resolvedInputs));
  const category = config.categories[hash % config.categories.length];
  return { category, model: config.model, mock: true };
}

// MOCK: stands in for actually performing an external side effect (an
// API call, sending an email, etc). The real safety mechanism here isn't
// this function - it's that the engine only calls it once per (run, step)
// thanks to idempotency_keys (see src/execution/idempotency.js).
function mockExternalAction(resolvedInputs, config) {
  return { ...config.mock_response, action_name: config.action_name, mock: true };
}

// The default dispatch table the engine uses. Tests can pass a different
// map of the same shape (e.g. a handler that throws N times before
// succeeding) to exercise retry logic without touching these mocks.
const defaultHandlers = {
  document_retrieval: mockDocumentRetrieval,
  ai_extraction: mockAiExtraction,
  ai_classification: mockAiClassification,
  mock_external_action: mockExternalAction,
};

module.exports = {
  mockDocumentRetrieval,
  mockAiExtraction,
  mockAiClassification,
  mockExternalAction,
  defaultHandlers,
};
