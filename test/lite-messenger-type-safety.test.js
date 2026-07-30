const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const MESSENGER_FILES = [
  'src/core/messenger.ts',
  'src/core/messenger-types.ts',
];

function parseSource(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  return ts.createSourceFile(
    absolutePath,
    fs.readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

describe('Lite Messenger type-safety gate', () => {
  it('does not allow explicit any in the Messenger core contract', () => {
    const violations = [];
    for (const relativePath of MESSENGER_FILES) {
      const source = parseSource(relativePath);
      walk(source, (node) => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${relativePath}:${position.line + 1}`);
        }
      });
    }
    assert.deepEqual(violations, []);
  });

  it('requires an explicit row type for every Messenger database read', () => {
    const relativePath = MESSENGER_FILES[0];
    const source = parseSource(relativePath);
    const violations = [];
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (!['get', 'all'].includes(node.expression.name.text)) return;

      const preparedStatement = node.expression.expression;
      if (!ts.isCallExpression(preparedStatement)
        || !ts.isPropertyAccessExpression(preparedStatement.expression)
        || preparedStatement.expression.name.text !== 'prepare') {
        return;
      }
      if (node.typeArguments?.length) return;

      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${relativePath}:${position.line + 1}`);
    });
    assert.deepEqual(violations, []);
  });
});
