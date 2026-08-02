// This file is the single source of truth for "what does each step type
// require". The validator (src/validation/validateWorkflowDefinition.js)
// reads this table instead of hard-coding a switch statement, so adding a
// new step type later means editing this file in one place.
//
// requiredConfigKeys: config keys that MUST be present (and non-empty) for
//   a step of this type. We only check *presence*, not the internal shape
//   of each value - deeper validation (e.g. "is this a valid model name")
//   is deliberately left to the step's own executor at run time, not the
//   definition validator. Keeping the definition validator shallow is what
//   keeps it explainable.
//
// requiresTools: true means a step of this type inherently calls out to
//   something outside the workflow engine itself (an LLM, an external
//   service, a document store), so the workflow author MUST declare which
//   tools/actions it's allowed to call in `permissions.tools`. This is the
//   platform's core safety rule: nothing that reaches outside the sandbox
//   can run without an explicit, auditable permission grant.
//
// referencesFields: which config keys (if any) hold step-id references used
//   for control flow (e.g. deterministic_condition branching to another
//   step). These are checked for dangling references and cycles exactly
//   like `inputs` references are.
//
// retryable: whether the EXECUTOR (src/execution/engine.js) is allowed to
//   automatically retry this step a few times when its handler throws,
//   with no human involved. This is only safe for steps that are read-only
//   / side-effect-free - re-running them changes nothing except maybe
//   which random-looking answer a mocked model gives. mock_external_action
//   is deliberately `false`: it performs a side effect (guarded by
//   idempotency_keys - see src/execution/idempotency.js), so a failed
//   attempt requires a human to explicitly confirm "yes, try again" via
//   the retry API rather than the engine silently looping.
const STEP_TYPES = {
  structured_input: {
    description: 'Manually supplied structured data that starts a run (an entry point).',
    requiredConfigKeys: ['fields'],
    requiresTools: false,
    referencesFields: [],
    isEntryPoint: true,
    retryable: false,
  },
  document_retrieval: {
    description: 'Fetches a document/record from a store (a file, a DB row, a CRM record, etc).',
    requiredConfigKeys: ['source', 'query'],
    requiresTools: true,
    referencesFields: [],
    isEntryPoint: false,
    retryable: true,
  },
  ai_extraction: {
    description: 'Uses a model to pull structured fields out of unstructured input.',
    requiredConfigKeys: ['model', 'output_fields'],
    requiresTools: true,
    referencesFields: [],
    isEntryPoint: false,
    retryable: true,
  },
  ai_classification: {
    description: 'Uses a model to assign one of a fixed set of categories.',
    requiredConfigKeys: ['model', 'categories'],
    requiresTools: true,
    referencesFields: [],
    isEntryPoint: false,
    retryable: true,
  },
  deterministic_condition: {
    description: 'Plain if/else branching on prior step outputs - no model, no tool call.',
    requiredConfigKeys: ['expression', 'on_true'],
    requiresTools: false,
    referencesFields: ['on_true', 'on_false'],
    isEntryPoint: false,
    retryable: false,
  },
  human_approval: {
    description: 'Pauses the run until a listed human approver approves or rejects it.',
    requiredConfigKeys: ['approvers', 'message'],
    requiresTools: false,
    referencesFields: [],
    isEntryPoint: false,
    retryable: false,
  },
  mock_external_action: {
    description: 'A stand-in for a real external side effect, used during development/testing.',
    requiredConfigKeys: ['action_name', 'mock_response'],
    requiresTools: true,
    referencesFields: [],
    isEntryPoint: false,
    retryable: false,
  },
  final_report: {
    description: 'Terminal step that assembles prior outputs into the run\'s final result.',
    requiredConfigKeys: ['template'],
    requiresTools: false,
    referencesFields: [],
    isEntryPoint: false,
    retryable: false,
  },
};

const STEP_TYPE_NAMES = Object.keys(STEP_TYPES);

// The single tool/action identifier a step of this type will attempt to
// invoke at run time, or null for types that never call out to anything.
// This is what the executor checks against `step.permissions.tools` before
// dispatching to a handler (see requirePermission() in
// src/execution/engine.js) - requirement 6's "tool/action permission
// enforcement".
//
// document_retrieval, ai_extraction, and ai_classification each represent
// exactly one *kind* of tool call (fetch a document, call the extraction
// model, call the classification model), so their identifier is a fixed
// constant regardless of config - a workflow author grants "this step may
// read documents" or "this step may call the LLM", not "this step may call
// gpt-4o-mini specifically". mock_external_action is different: it's a
// stand-in for an arbitrary named external system, so the tool identifier
// IS whatever the workflow author put in config.action_name - permission
// is granted per concrete action, not per step type.
function requiredToolForStep(step) {
  switch (step.type) {
    case 'document_retrieval':
      return 'document_store.read';
    case 'ai_extraction':
    case 'ai_classification':
      return 'llm.invoke';
    case 'mock_external_action':
      return step.config?.action_name || null;
    default:
      return null;
  }
}

// Which audit_log event_type a step's external call (if any) should be
// filed under. The observability requirement asks for "every AI call" and
// "every tool call" to be distinguishable in the trail, so this is a
// separate, slightly coarser grouping than requiredToolForStep: both
// ai_extraction and ai_classification report as 'ai_call' regardless of
// which model they're configured with, while document_retrieval and
// mock_external_action report as 'tool_call'. Returns null for step types
// that never call anything (same set requiredToolForStep returns null for).
function auditCategoryForStep(step) {
  switch (step.type) {
    case 'ai_extraction':
    case 'ai_classification':
      return 'ai_call';
    case 'document_retrieval':
    case 'mock_external_action':
      return 'tool_call';
    default:
      return null;
  }
}

module.exports = { STEP_TYPES, STEP_TYPE_NAMES, requiredToolForStep, auditCategoryForStep };
