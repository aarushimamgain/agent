// Validates a workflow definition BEFORE it is allowed to become a
// workflow_versions row (and therefore before it can ever be run).
//
// This is deliberately a hand-written set of checks rather than a generic
// JSON-Schema validator, because most of what actually matters here -
// "does this reference point at a step that exists", "is this graph
// acyclic", "does every step that calls a tool declare permission to do
// so" - is cross-field/graph-shaped and doesn't express well as JSON
// Schema. src/schema/workflowDefinition.schema.json documents the shape;
// this file enforces the rules that give the platform its "controlled" in
// "Controlled Agentic Workflow Automation Platform".
//
// The function never throws for a bad definition - it always returns
// { valid, errors }, so callers (the Express route, or a script) decide
// what to do with a bad definition instead of catching exceptions.

const { STEP_TYPES, STEP_TYPE_NAMES } = require('../schema/stepTypes');

// Which config keys are expected to be a non-empty array vs a non-empty
// string. Used to give a precise error ("approvers must be a non-empty
// array") instead of just "approvers is required". Keys not listed here
// are only checked for presence (not undefined/null).
const ARRAY_CONFIG_KEYS = new Set(['approvers', 'categories', 'output_fields', 'fields']);
const STRING_CONFIG_KEYS = new Set([
  'model', 'source', 'query', 'expression', 'message', 'action_name', 'template', 'on_true',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addError(errors, path, message) {
  errors.push({ path, message });
}

// Checks the `config` object for a single step against the requirements
// declared for its type in STEP_TYPES.requiredConfigKeys.
function validateStepConfig(step, stepTypeSpec, errors) {
  const config = step.config;
  for (const key of stepTypeSpec.requiredConfigKeys) {
    const value = config ? config[key] : undefined;

    if (value === undefined || value === null) {
      addError(errors, `steps[${step.id}].config.${key}`, `Missing required config "${key}" for step type "${step.type}".`);
      continue;
    }

    if (ARRAY_CONFIG_KEYS.has(key) && !(Array.isArray(value) && value.length > 0)) {
      addError(errors, `steps[${step.id}].config.${key}`, `"${key}" must be a non-empty array.`);
    } else if (STRING_CONFIG_KEYS.has(key) && !isNonEmptyString(value)) {
      addError(errors, `steps[${step.id}].config.${key}`, `"${key}" must be a non-empty string.`);
    }
  }

  // ai_classification needs at least two categories to mean anything.
  if (step.type === 'ai_classification' && Array.isArray(config?.categories) && config.categories.length < 2) {
    addError(errors, `steps[${step.id}].config.categories`, 'A classification step needs at least two categories.');
  }
}

// Checks `permissions.tools` for steps whose type inherently calls
// something outside the engine (see STEP_TYPES.requiresTools).
function validateStepPermissions(step, stepTypeSpec, errors) {
  if (!stepTypeSpec.requiresTools) return;

  const tools = step.permissions?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    addError(
      errors,
      `steps[${step.id}].permissions.tools`,
      `Step type "${step.type}" calls out to a tool and must declare at least one entry in permissions.tools.`
    );
  }
}

// Validates one `inputs` entry. A value is either a literal (left alone)
// or a reference object { from, output }. Returns the referenced step id
// if this entry is a reference, otherwise null - the caller uses this to
// build the dependency graph.
function validateInputRef(step, inputName, value, idSet, errors) {
  const isRefShape = value && typeof value === 'object' && !Array.isArray(value) && 'from' in value;
  if (!isRefShape) return null; // literal value, nothing to check

  if (!isNonEmptyString(value.from)) {
    addError(errors, `steps[${step.id}].inputs.${inputName}.from`, 'Reference is missing a valid "from" step id.');
    return null;
  }
  if (!isNonEmptyString(value.output)) {
    addError(errors, `steps[${step.id}].inputs.${inputName}.output`, 'Reference is missing a valid "output" field name.');
  }
  if (value.from === step.id) {
    addError(errors, `steps[${step.id}].inputs.${inputName}`, 'A step cannot reference its own output.');
    return null;
  }
  if (!idSet.has(value.from)) {
    addError(
      errors,
      `steps[${step.id}].inputs.${inputName}`,
      `References step "${value.from}", which does not exist in this workflow (dangling reference).`
    );
    return null;
  }
  return value.from;
}

// Checks the step-id references used for control flow (currently only
// deterministic_condition.config.on_true / on_false).
function validateControlFlowRefs(step, stepTypeSpec, idSet, errors) {
  const refs = [];
  for (const key of stepTypeSpec.referencesFields) {
    const target = step.config?.[key];
    if (target === undefined || target === null) continue; // on_false is optional
    if (!isNonEmptyString(target)) {
      addError(errors, `steps[${step.id}].config.${key}`, `"${key}" must be a step id (string).`);
      continue;
    }
    if (target === step.id) {
      addError(errors, `steps[${step.id}].config.${key}`, 'A step cannot branch to itself.');
      continue;
    }
    if (!idSet.has(target)) {
      addError(errors, `steps[${step.id}].config.${key}`, `Branches to step "${target}", which does not exist (dangling reference).`);
      continue;
    }
    refs.push(target);
  }
  return refs;
}

// Standard three-color DFS cycle detection over the dependency graph built
// from inputs-references and control-flow-references. `graph` is a Map of
// stepId -> array of stepIds it points at.
function findCycle(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of graph.keys()) color.set(id, WHITE);

  let cyclePath = null;

  function visit(id, path) {
    color.set(id, GRAY);
    path.push(id);

    for (const next of graph.get(id) || []) {
      if (color.get(next) === GRAY) {
        cyclePath = [...path.slice(path.indexOf(next)), next];
        return true;
      }
      if (color.get(next) === WHITE && visit(next, path)) {
        return true;
      }
    }

    path.pop();
    color.set(id, BLACK);
    return false;
  }

  for (const id of graph.keys()) {
    if (color.get(id) === WHITE && visit(id, [])) {
      return cyclePath;
    }
  }
  return null;
}

function validateWorkflowDefinition(definition) {
  const errors = [];

  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { valid: false, errors: [{ path: '', message: 'Definition must be a JSON object.' }] };
  }
  if (!isNonEmptyString(definition.name)) {
    addError(errors, 'name', 'Workflow "name" is required and must be a non-empty string.');
  }
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    addError(errors, 'steps', 'Workflow must have a non-empty "steps" array.');
    return { valid: false, errors }; // nothing further to check without steps
  }

  // --- pass 1: shape of each step, and collect ids ---
  const idSet = new Set();
  const duplicateIds = new Set();
  definition.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    if (!step || typeof step !== 'object') {
      addError(errors, path, 'Each step must be an object.');
      return;
    }
    if (!isNonEmptyString(step.id)) {
      addError(errors, `${path}.id`, 'Step is missing a valid "id".');
    } else if (idSet.has(step.id)) {
      duplicateIds.add(step.id);
    } else {
      idSet.add(step.id);
    }
    if (!STEP_TYPE_NAMES.includes(step.type)) {
      addError(errors, `${path}.type`, `"${step.type}" is not a valid step type. Valid types: ${STEP_TYPE_NAMES.join(', ')}.`);
    }
    if (!step.inputs || typeof step.inputs !== 'object' || Array.isArray(step.inputs)) {
      addError(errors, `${path}.inputs`, '"inputs" must be an object (use {} if the step takes none).');
    }
    if (!step.config || typeof step.config !== 'object' || Array.isArray(step.config)) {
      addError(errors, `${path}.config`, '"config" must be an object.');
    }
    if (!step.permissions || typeof step.permissions !== 'object' || !Array.isArray(step.permissions.tools)) {
      addError(errors, `${path}.permissions`, '"permissions" must be an object with a "tools" array (use [] if none needed).');
    }
  });
  for (const id of duplicateIds) {
    addError(errors, 'steps', `Step id "${id}" is used more than once.`);
  }

  // A structured_input step is an entry point and must not declare inputs
  // referencing other steps (there's nothing before it to reference).
  const entryPointTypes = new Set(STEP_TYPE_NAMES.filter((t) => STEP_TYPES[t].isEntryPoint));

  // --- pass 2: per-step semantic checks (only for steps whose shape passed pass 1) ---
  const graph = new Map(); // stepId -> [stepIds it depends on / branches to]
  for (const id of idSet) graph.set(id, []);

  for (const step of definition.steps) {
    if (!step || typeof step !== 'object' || !isNonEmptyString(step.id) || !STEP_TYPE_NAMES.includes(step.type)) {
      continue; // already reported in pass 1
    }
    const stepTypeSpec = STEP_TYPES[step.type];
    const edges = graph.get(step.id) || [];

    validateStepConfig(step, stepTypeSpec, errors);
    validateStepPermissions(step, stepTypeSpec, errors);

    if (step.inputs && typeof step.inputs === 'object') {
      if (entryPointTypes.has(step.type) && Object.keys(step.inputs).length > 0) {
        addError(errors, `steps[${step.id}].inputs`, `Step type "${step.type}" is an entry point and must not declare inputs.`);
      }
      for (const [inputName, value] of Object.entries(step.inputs)) {
        const referencedId = validateInputRef(step, inputName, value, idSet, errors);
        if (referencedId) edges.push(referencedId);
      }
    }

    edges.push(...validateControlFlowRefs(step, stepTypeSpec, idSet, errors));

    // human_approval steps must define who can act on them - this is
    // technically already covered by requiredConfigKeys including
    // 'approvers', but we call it out as its own named rule because it's
    // one of the platform's explicit safety requirements, not an
    // incidental config detail.
    if (step.type === 'human_approval') {
      const approvers = step.config?.approvers;
      if (!Array.isArray(approvers) || approvers.length === 0) {
        addError(errors, `steps[${step.id}].config.approvers`, 'human_approval steps must list at least one approver.');
      }
    }

    graph.set(step.id, edges);
  }

  // --- pass 3: cycle detection over the whole graph ---
  const cycle = findCycle(graph);
  if (cycle) {
    addError(errors, 'steps', `Cycle detected in step graph: ${cycle.join(' -> ')}.`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateWorkflowDefinition };
