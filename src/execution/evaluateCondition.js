// Evaluates a deterministic_condition step's `config.expression` against
// its resolved inputs.
//
// This deliberately supports only ONE tiny grammar - `<inputName> ==
// 'literal'` or `<inputName> != 'literal'` - instead of a general
// expression language. The obvious alternative (`new Function(expression)`
// or `eval`) would let a workflow DEFINITION execute arbitrary JavaScript
// inside the server process, which is exactly the kind of "agentic
// automation gone uncontrolled" this platform exists to prevent. A real
// product would likely embed a vetted, sandboxed expression library (e.g.
// json-logic-js); for this foundation, a hand-rolled parser for the one
// shape we actually need keeps the security story simple enough to
// explain in one paragraph.
const CONDITION_PATTERN = /^\s*([a-zA-Z_][\w]*)\s*(==|!=)\s*'([^']*)'\s*$/;

function evaluateCondition(expression, resolvedInputs) {
  const match = CONDITION_PATTERN.exec(expression);
  if (!match) {
    throw new Error(
      `Unsupported condition expression: "${expression}". Only "<input> == 'value'" and "<input> != 'value'" are supported.`
    );
  }
  const [, inputName, operator, literal] = match;
  const actual = resolvedInputs[inputName];
  const isEqual = String(actual) === literal;
  return operator === '==' ? isEqual : !isEqual;
}

module.exports = { evaluateCondition };
