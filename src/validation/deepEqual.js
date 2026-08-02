// Plain recursive structural equality for JSON-safe values (objects,
// arrays, strings, numbers, booleans, null). We need this instead of
// `JSON.stringify(a) === JSON.stringify(b)` because stringify is sensitive
// to object key order, and two semantically-identical `config` objects
// re-serialized by different code paths are not guaranteed to have their
// keys in the same order.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false; // primitives already handled by ===

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

module.exports = { deepEqual };
