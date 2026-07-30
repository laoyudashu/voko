const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const liteRoot = path.join(__dirname, '..');
const buildRoot = path.join(liteRoot, 'build');

test('Lite 只发布当前使用的 Agent 文件边界模块', () => {
  const legacyManager = path.join(buildRoot, 'server', 'agent-manager.js');
  assert.equal(
    fs.existsSync(legacyManager),
    false,
    '未被运行时引用的 legacy server/agent-manager 不应进入构建产物',
  );

  const agentFiles = require(path.join(buildRoot, 'core', 'agent-files.js'));
  assert.equal(typeof agentFiles.getAgentFiles, 'function');
  assert.equal(typeof agentFiles.readFile, 'function');
  assert.equal(typeof agentFiles.writeFile, 'function');
});

test('Lite HTTP Agent 文件路由不再依赖 global.__agentManager', () => {
  const source = fs.readFileSync(path.join(liteRoot, 'src', 'index.ts'), 'utf8');
  const boundaryStart = source.indexOf("const agentFiles = require('./core/agent-files')");
  const routeStart = source.indexOf("app.get('/api/agent/files'");
  const routeEnd = source.indexOf('//  版本发布 API', routeStart);
  const routeSection = source.slice(
    boundaryStart,
    routeEnd > routeStart ? routeEnd : routeStart + 3000,
  );

  assert.ok(boundaryStart >= 0, '应加载 core/agent-files');
  assert.ok(routeStart >= 0, '应存在 Agent 文件路由');
  assert.match(routeSection, /require\('\.\/core\/agent-files'\)/);
  assert.doesNotMatch(routeSection, /__agentManager/);
});
