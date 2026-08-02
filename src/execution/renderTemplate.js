// Renders a final_report step's `config.template` by substituting
// {{inputName}} placeholders with the step's resolved inputs. Like
// evaluateCondition, this is a minimal hand-rolled substitution (a regex
// replace) rather than a templating engine - final_report has no
// conditionals or loops in its template, just "fill in these values", so a
// full templating dependency would be more machinery than the feature
// needs.
function renderTemplate(template, resolvedInputs) {
  return template.replace(/{{\s*([a-zA-Z_][\w]*)\s*}}/g, (match, name) => {
    if (!(name in resolvedInputs)) return match; // leave unresolved placeholders visible rather than silently blanking them
    const value = resolvedInputs[name];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

module.exports = { renderTemplate };
