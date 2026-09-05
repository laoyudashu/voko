export {};

/** Compare dotted version numbers: a<b -> -1, a==b -> 0, a>b -> 1. */
function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 {
  const left = String(a || '').split('.').map((part) => parseInt(part, 10) || 0);
  const right = String(b || '').split('.').map((part) => parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index] || 0;
    const rightPart = right[index] || 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

module.exports = { compareVersions };
