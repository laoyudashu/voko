const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const ts = require('typescript');
const { makeT } = require('../build/core/i18n');
const { createGroupRouter } = require('../build/web/group');

function createDb(imUid) {
  return {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('SELECT imUid FROM agents')) return { imUid };
          return undefined;
        },
        all() {
          return [];
        },
        run() {},
      };
    },
  };
}

function startServer(role) {
  const imUid = 'agent-im-uid';
  const handlers = {
    whoami: async () => ({
      agents: [{ agentId: 'agent-1', agentName: 'Agent One' }],
    }),
    get_group_context: async () => ({
      success: true,
      groupName: 'Test Group',
      status: 'active',
      members: [
        { uid: imUid, nickname: 'Agent One', role },
        { uid: 'visitor-1', nickname: 'Visitor', role: 'member' },
      ],
      messages: [],
      hasMore: false,
    }),
    list_group_applies: async () => ({ success: true, applies: [] }),
  };
  const app = express();
  app.use((req, _res, next) => {
    req.locale = 'zh';
    req.t = makeT('zh');
    next();
  });
  app.use(createGroupRouter(handlers, createDb(imUid)));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        async close() {
          server.closeIdleConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
    server.once('error', reject);
  });
}

async function renderGroup(t, role) {
  const server = await startServer(role);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/agents/agent-1/g/group-1`, {
    signal: AbortSignal.timeout(3000),
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  return html;
}

describe('Web group detail rendering', () => {
  it('injects manager capability for an owner', async (t) => {
    const html = await renderGroup(t, 'owner');
    assert.match(html, /window\.__IS_MANAGER__=true;/);
  });

  it('injects no manager capability for an ordinary member', async (t) => {
    const html = await renderGroup(t, 'member');
    assert.match(html, /window\.__IS_MANAGER__=false;/);
  });
});

it('Lite Web JS has no unresolved server-side identifiers', () => {
  const liteDir = path.resolve(__dirname, '..');
  const configPath = path.join(liteDir, 'tsconfig.json');
  const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(rawConfig.error, undefined);
  const config = ts.parseJsonConfigFileContent(
    rawConfig.config,
    ts.sys,
    liteDir,
    { checkJs: true, noEmit: true },
    configPath,
  );
  const program = ts.createProgram(config.fileNames, config.options);
  const relevantCodes = new Set([2304, 2448, 2454, 2552, 2554]);
  const webDir = path.join('src', 'web');
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => (
    diagnostic.file
    && diagnostic.file.fileName.includes(webDir)
    && relevantCodes.has(diagnostic.code)
  ));
  const messages = diagnostics.map((diagnostic) => {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start || 0);
    return `${path.relative(liteDir, diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1}`
      + ` TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  assert.deepEqual(messages, []);
});
