const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { toggleWhitelistMode } = require('../build/core/access-control');
const { setAgentStatus } = require('../build/core/set-agent-status');
const { publishAgent, unpublishAgent } = require('../build/core/publish-agent');
const { PowerManager } = require('../build/core/power-manager');
const { updateAgentProfile } = require('../build/core/update-agent-profile');
const { searchCapabilitiesByUserToken } = require('../build/core/search-capabilities');
const { registerCapabilitiesForAgent } = require('../build/core/register-capabilities');
const { createAgentRegistration } = require('../build/core/agent-registration');
const { createScheduler, createWatchdog } = require('../build/core/scheduler');
const autoUpdater = require('../build/core/auto-updater');
const { syncOfflineMessages } = require('../build/core/offline-sync');
const { createDeliver, createSecureDeliverProxy, createSendMessage } = require('../build/core/send-message');
const { processPendingPaymentOrder, startPaymentPolling } = require('../build/core/payment');
const { selectWindowsOpenclawCommand } = require('../build/core/dispatcher/providers/openclaw-ws');
const { normalizeOfficialImServerUrl, normalizeOfficialPublicUrl } = require('../build/core/url-security');
const ENDPOINTS = require('../build/endpoints.json');

const TEST_PRIVATE_KEY = Buffer.alloc(32, 1).toString('hex');

test('official public URLs use the non-redirecting www host', () => {
  assert.equal(ENDPOINTS.api.baseUrl, 'https://www.vokovoko.com');
  assert.equal(
    normalizeOfficialPublicUrl('https://vokovoko.com/s/agent-1', { canonicalMain: true }),
    'https://www.vokovoko.com/s/agent-1',
  );
  assert.equal(
    normalizeOfficialPublicUrl('https://www.vokovoko.com/s/agent-1', { canonicalMain: true }),
    'https://www.vokovoko.com/s/agent-1',
  );
});

test('IM credentials can only be sent to the official secure endpoint', () => {
  assert.equal(
    normalizeOfficialImServerUrl('wss://wukongim.vokovoko.com/'),
    'wss://wukongim.vokovoko.com',
  );
  assert.throws(
    () => normalizeOfficialImServerUrl('wss://example.test'),
    /无效|invalid|endpoint|VOKO/i,
  );
});

function createAgentDb(row) {
  const data = row ? { ...row } : null;
  const writes = [];
  return {
    data,
    writes,
    prepare(sql) {
      return {
        get() { return data; },
        run(...args) {
          writes.push({ sql, args });
          if (!data) return;
          if (sql.includes('SET publish_status')) {
            data.publish_status = args[0];
            if (sql.includes('visibility_type')) data.visibility_type = args[1];
            data.updated_at = sql.includes('visibility_type') ? args[2] : args[1];
          }
          if (sql.includes('SET access_mode')) {
            data.access_mode = args[0];
            data.updated_at = args[1];
          }
        },
      };
    },
  };
}

test('OpenClaw Windows resolver prefers an executable shim over the extensionless shell script', () => {
  assert.deepEqual(
    selectWindowsOpenclawCommand('D:\\npm\\openclaw\r\nD:\\npm\\openclaw.cmd\r\nD:\\npm\\openclaw.ps1\r\n'),
    { cmd: 'D:\\npm\\openclaw.cmd', shell: true },
  );
  assert.deepEqual(
    selectWindowsOpenclawCommand('D:\\npm\\openclaw\r\n', (candidate) => candidate.endsWith('openclaw.cmd')),
    { cmd: 'D:\\npm\\openclaw.cmd', shell: true },
  );
});

function createCapabilityDb() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        get() {
          return {
            did: 'did:test:agent-1',
            private_key: TEST_PRIVATE_KEY,
            ability: '["chat"]',
            capability: '{"skills":[{"name":"custom"}]}',
          };
        },
        all() {
          return sql.includes('agent_skills')
            ? [{ skill_name: 'chat', enabled: 1, config: null }]
            : [];
        },
        run(...args) { writes.push({ sql, args }); },
      };
    },
  };
}

test('Lite access control keeps local and remote status mapping stable', async () => {
  const db = createAgentDb({ publish_status: 'published', access_mode: 'public', visibility_type: 0 });
  const statusCalls = [];
  const result = await toggleWhitelistMode({
    db,
    agentId: 'agent-1',
    enabled: true,
    setAgentStatus: async (params) => statusCalls.push(params),
  });

  assert.deepEqual(result, {
    success: true,
    accessMode: 'private',
    localUpdated: true,
    capabilitySynced: true,
    statusSynced: true,
    syncWarnings: [],
  });
  assert.equal(db.data.access_mode, 'private');
  assert.deepEqual(statusCalls, [{ agentId: 'agent-1', status: 1, visibility: 0 }]);
});

test('Lite access control preserves local success when optional remote sync fails', async () => {
  const db = createAgentDb({ publish_status: 'published', access_mode: 'private' });
  const result = await toggleWhitelistMode({
    db,
    agentId: 'agent-1',
    enabled: false,
    setAgentStatus: async () => { throw new Error('status unavailable'); },
  });

  assert.equal(result.success, true);
  assert.equal(result.accessMode, 'public');
  assert.equal(result.localUpdated, true);
  assert.equal(result.capabilitySynced, true);
  assert.equal(result.statusSynced, false);
  assert.equal(result.syncWarnings.length, 1);
  assert.match(result.syncWarnings[0], /status unavailable/);
  assert.equal(db.data.access_mode, 'public');
});

test('Lite access control reports returned status synchronization failures', async () => {
  const cases = [
    {
      statusResult: { success: true },
      statusSynced: true,
      warningCount: 0,
    },
    {
      statusResult: { success: false, error: 'status rejected' },
      statusSynced: false,
      warning: /status rejected/,
      warningCount: 1,
    },
  ];

  for (const item of cases) {
    const db = createAgentDb({ publish_status: 'published', access_mode: 'public' });
    const result = await toggleWhitelistMode({
      db,
      agentId: 'agent-1',
      enabled: true,
      setAgentStatus: async () => item.statusResult,
    });
    assert.equal(result.success, true);
    assert.equal(result.localUpdated, true);
    assert.equal(result.capabilitySynced, true);
    assert.equal(result.statusSynced, item.statusSynced);
    assert.equal(result.syncWarnings.length, item.warningCount);
    if (item.warning) assert.match(result.syncWarnings.join('\n'), item.warning);
    assert.equal(db.data.access_mode, 'private');
  }
});

test('Lite access control rejects missing required dependencies', async () => {
  assert.deepEqual(await toggleWhitelistMode(), { success: false, error: 'db is required' });
  assert.deepEqual(
    await toggleWhitelistMode({ db: createAgentDb(null) }),
    { success: false, error: 'agentId is required' },
  );
});

test('Lite set-agent-status signs, posts and updates the local row on success', async (t) => {
  const db = createAgentDb({
    did: 'did:test:agent-1',
    private_key: TEST_PRIVATE_KEY,
    access_mode: 'private',
  });
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { json: async () => ({ success: true }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await setAgentStatus({ db, agentId: 'agent-1', status: 1, visibility: 0 });
  assert.deepEqual(result, { success: true, publishStatus: 'published', accessMode: 'private' });
  assert.match(request.url, /\/api\/did-auth\/set-agent-status$/);
  assert.equal(request.options.method, 'POST');
  const body = JSON.parse(request.options.body);
  assert.equal(body.did, 'did:test:agent-1');
  assert.equal(body.status, 1);
  assert.equal(body.visibility, 0);
  assert.equal(typeof body.signature, 'string');
  assert.equal(db.data.publish_status, 'published');
  assert.equal(db.data.access_mode, 'private');
  assert.equal(db.data.visibility_type, 0);
});

test('Lite set-agent-status does not update local state on rejection or missing DID', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ success: false, message: 'rejected' }) });
  t.after(() => { global.fetch = originalFetch; });

  const rejectedDb = createAgentDb({
    did: 'did:test:agent-1',
    private_key: TEST_PRIVATE_KEY,
  });
  assert.deepEqual(
    await setAgentStatus({ db: rejectedDb, agentId: 'agent-1', status: 0, visibility: 1 }),
    { success: false, error: 'rejected' },
  );
  assert.equal(rejectedDb.writes.length, 0);

  const missingDidDb = createAgentDb({ did: null, private_key: null });
  assert.deepEqual(
    await setAgentStatus({ db: missingDidDb, agentId: 'agent-1', status: 1, visibility: 1 }),
    { success: false, error: 'Agent has no DID' },
  );
});

test('Lite set-agent-status rejects invalid flags before database or network access', async (t) => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  let prepareCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    throw new Error('fetch must not be called');
  };
  t.after(() => { global.fetch = originalFetch; });

  const db = {
    prepare() {
      prepareCalls++;
      throw new Error('database must not be accessed');
    },
  };
  const invalidCases = [
    { status: -1, visibility: 0 },
    { status: 2, visibility: 1 },
    { status: 1, visibility: -1 },
    { status: 0, visibility: 3 },
    { status: '1', visibility: 0 },
    { status: 1, visibility: '0' },
    { status: true, visibility: 0 },
    { status: 1, visibility: null },
    { status: Number.NaN, visibility: 1 },
    { status: 1, visibility: Number.NaN },
  ];

  for (const flags of invalidCases) {
    const result = await setAgentStatus({ db, agentId: 'agent-1', ...flags });
    assert.equal(result.success, false);
    assert.match(result.error, /0.*1/);
  }
  for (const flags of [{ status: 1 }, { visibility: 0 }, {}]) {
    const result = await setAgentStatus({ db, agentId: 'agent-1', ...flags });
    assert.equal(result.success, false);
    assert.match(result.error, /status|visibility/i);
  }
  assert.equal(prepareCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('Lite set-agent-status accepts all six valid status and visibility combinations', async (t) => {
  const originalFetch = global.fetch;
  let signedFetchCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/did-auth/set-agent-status')) signedFetchCalls++;
    return { json: async () => ({ success: true }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  for (const status of [0, 1]) {
    for (const visibility of [0, 1, 2]) {
      const db = createAgentDb({
        did: 'did:test:agent-1',
        private_key: TEST_PRIVATE_KEY,
        access_mode: 'private',
      });
      const result = await setAgentStatus({
        db,
        agentId: 'agent-1',
        status,
        visibility,
      });
      assert.equal(result.success, true);
      assert.equal(db.data.publish_status, status === 1 ? 'published' : 'unpublished');
      assert.equal(db.data.access_mode, 'private');
      assert.equal(db.data.visibility_type, visibility);
    }
  }
  assert.equal(signedFetchCalls, 6);
});

test('Lite set-agent-status classifies invalid external API responses without local writes', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const cases = [
    {
      response: { ok: false, status: 401, json: async () => ({ success: false, message: 'unauthorized' }) },
      error: 'unauthorized',
    },
    {
      response: { ok: false, status: 500, json: async () => ({ success: false }) },
      error: /HTTP 500/,
    },
    {
      response: { ok: false, status: 502, json: async () => { throw new SyntaxError('HTML'); } },
      error: /JSON/i,
    },
    {
      response: { ok: true, status: 200, json: async () => ({ message: 'missing success' }) },
      error: /结构|response/i,
    },
  ];

  for (const item of cases) {
    const db = createAgentDb({
      did: 'did:test:agent-1',
      private_key: TEST_PRIVATE_KEY,
    });
    global.fetch = async () => item.response;
    const result = await setAgentStatus({ db, agentId: 'agent-1', status: 1, visibility: 1 });
    assert.equal(result.success, false);
    if (typeof item.error === 'string') assert.equal(result.error, item.error);
    else assert.match(result.error, item.error);
    assert.equal(db.writes.length, 0);
  }

  global.fetch = async () => { throw new Error('network unavailable'); };
  const networkDb = createAgentDb({
    did: 'did:test:agent-1',
    private_key: TEST_PRIVATE_KEY,
  });
  assert.deepEqual(
    await setAgentStatus({ db: networkDb, agentId: 'agent-1', status: 1, visibility: 1 }),
    { success: false, error: 'network unavailable' },
  );
  assert.equal(networkDb.writes.length, 0);
});

test('Lite event log writes one structured JSONL record in the configured data directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-event-log-'));
  const dataDir = path.join(tempDir, 'logs');
  const env = { ...process.env, VOKO_LOG_DIR: dataDir };
  const script = [
    "const { logEvent } = require('./build/core/event-log');",
    "logEvent('message.received', { level: 'debug', agentId: 'agent-1', data: { count: 2 } });",
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
    windowsHide: true,
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    const content = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim();
    const entry = JSON.parse(content);
    assert.equal(entry.event, 'message.received');
    assert.equal(entry.level, 'debug');
    assert.equal(entry.agentId, 'agent-1');
    assert.deepEqual(entry.data, { count: 2 });
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Lite publish and unpublish preserve access mode and worker lifecycle', async () => {
  const db = createAgentDb({
    agent_id: 'agent-1',
    imUid: 'uid-1',
    imToken: 'token-1',
    im_server_url: 'ws://im.test',
    publish_status: 'unpublished',
    access_mode: 'public',
    backend_type: 'openclaw',
  });
  const originalPrepare = db.prepare;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const originalGet = statement.get;
    statement.get = (...args) => sql.includes('agent_id !=') ? undefined : originalGet(...args);
    statement.run = (...args) => {
      db.writes.push({ sql, args });
      if (sql.includes('INSERT INTO agents')) db.data.publish_status = 'published';
      if (sql.includes("publish_status = 'unpublished'")) db.data.publish_status = 'unpublished';
    };
    return statement;
  };

  const lifecycle = [];
  const statuses = [];
  const published = await publishAgent({
    db,
    agentId: 'agent-1',
    startAgentWorker: (id, config) => lifecycle.push({ action: 'start', id, config }),
    setAgentStatus: async (params) => statuses.push(params),
    endpoints: { im: { baseUrl: 'https://im.test' } },
  });
  assert.deepEqual(published, { success: true, publishStatus: 'published', accessMode: 'public' });
  assert.equal(lifecycle[0].action, 'start');
  assert.deepEqual(statuses[0], { agentId: 'agent-1', status: 1, visibility: 1 });

  const unpublished = await unpublishAgent({
    db,
    agentId: 'agent-1',
    stopAgentWorker: async (id) => lifecycle.push({ action: 'stop', id }),
    setAgentStatus: async (params) => statuses.push(params),
  });
  assert.deepEqual(unpublished, { success: true, publishStatus: 'unpublished' });
  assert.equal(lifecycle[1].action, 'stop');
  assert.deepEqual(statuses[1], { agentId: 'agent-1', status: 0, visibility: 1 });
});

test('Lite publish waits for the real IM connection status without blocking publication', async () => {
  const db = createAgentDb({
    agent_id: 'agent-1',
    imUid: 'uid-1',
    imToken: 'token-1',
    im_server_url: 'ws://im.test',
    publish_status: 'unpublished',
    access_mode: 'private',
    backend_type: 'openclaw',
  });
  const originalPrepare = db.prepare;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const originalGet = statement.get;
    statement.get = (...args) => sql.includes('agent_id !=') ? undefined : originalGet(...args);
    return statement;
  };
  let waited = 0;
  const result = await publishAgent({
    db,
    agentId: 'agent-1',
    startAgentWorker: async () => ({ connected: false, status: 'connecting' }),
    waitForAgentConnection: async () => {
      waited++;
      return { connected: true, status: 'connected' };
    },
  });
  assert.equal(result.success, true);
  assert.equal(waited, 1);
  assert.deepEqual(result.imConnection, { connected: true, status: 'connected' });
});

test('Lite publish rejects missing IM binding and duplicate IM identity', async () => {
  const missing = createAgentDb({ agent_id: 'agent-1' });
  assert.equal((await publishAgent({ db: missing, agentId: 'agent-1' })).success, false);

  const duplicate = createAgentDb({
    agent_id: 'agent-1',
    imUid: 'uid-1',
    imToken: 'token-1',
    im_server_url: 'ws://im.test',
  });
  duplicate.prepare = (sql) => ({
    get: (...args) => sql.includes('agent_id !=')
      ? { agent_id: 'agent-2' }
      : duplicate.data,
    run: () => {},
  });
  const result = await publishAgent({ db: duplicate, agentId: 'agent-1' });
  assert.equal(result.success, false);
  assert.match(result.error, /uid-1/);
});

test('PowerManager recovery restarts only published agents for the active owner', async () => {
  const stopped = [];
  const started = [];
  const manager = {
    workers: new Map([['old-1', {}], ['old-2', {}]]),
    async stop(id) { stopped.push(id); },
    async start(id, config) { started.push({ id, config }); return { connected: true }; },
  };
  const db = {
    prepare(sql) {
      return {
        get() {
          return { data: JSON.stringify({ userEmail: 'owner@example.com' }) };
        },
        all(...args) {
          assert.match(sql, /owner_email = \?/);
          assert.deepEqual(args, ['owner@example.com']);
          return [{
            agent_id: 'agent-1',
            imUid: 'uid-1',
            imToken: 'token-1',
            im_server_url: 'wss://wukongim.vokovoko.com',
          }];
        },
      };
    },
  };
  const power = new PowerManager(manager, db, {
    checkInterval: 10,
    driftThreshold: 20,
    networkProbe: async () => true,
    delay: async () => {},
  });
  await power._recover();

  assert.deepEqual(stopped, ['old-1', 'old-2']);
  assert.deepEqual(started, [{
    id: 'agent-1',
    config: { uid: 'uid-1', token: 'token-1', serverUrl: 'wss://wukongim.vokovoko.com' },
  }]);
  power.start();
  power.start();
  assert.ok(power._timer);
  power.stop();
  assert.equal(power._timer, null);
});

test('PowerManager only logs a visible success message after resume recovery', async () => {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const manager = {
      workers: new Map(),
      async stop() {},
      async startMany(entries) {
        return entries.map(entry => ({ agentId: entry.agentId, connected: true }));
      },
    };
    const db = {
      prepare(sql) {
        return {
          get: () => ({ data: '{}' }),
          all: () => [{
            agent_id: 'agent-1',
            imUid: 'uid-1',
            imToken: 'token-1',
            im_server_url: 'wss://wukongim.vokovoko.com',
          }],
        };
      },
    };
    const power = new PowerManager(manager, db, { networkProbe: async () => true });
    power.start();
    power.stop();
    assert.equal(logs.some(log => log.includes('休眠唤醒检测已启动')), false);

    await power._recover();
    assert.equal(logs.some(log => log.includes('✅ 系统唤醒恢复成功')), true);
    assert.equal(errors.some(log => log.includes('✅ 系统唤醒恢复成功')), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('PowerManager retries only failed IM connections and awaits the real result', async () => {
  const rounds = [];
  const manager = {
    workers: new Map([['old-1', {}]]),
    async stop() {},
    async start() { throw new Error('start fallback should not be used'); },
    async startMany(entries, options) {
      rounds.push({ ids: entries.map(entry => entry.agentId), options });
      return entries.map(entry => ({
        agentId: entry.agentId,
        connected: entry.agentId === 'agent-ok' || rounds.length > 1,
      }));
    },
  };
  const db = {
    prepare(sql) {
      return {
        get: () => ({ data: '{}' }),
        all: () => [
          { agent_id: 'agent-ok', imUid: 'uid-ok', imToken: 'token-ok', im_server_url: 'wss://wukongim.vokovoko.com' },
          { agent_id: 'agent-retry', imUid: 'uid-retry', imToken: 'token-retry', im_server_url: 'wss://wukongim.vokovoko.com' },
        ],
      };
    },
  };
  const delays = [];
  const power = new PowerManager(manager, db, {
    recoveryAttempts: 3,
    recoveryBackoffMs: 10,
    recoveryConcurrency: 2,
    recoveryStaggerMs: 25,
    networkProbe: async () => true,
    delay: async ms => { delays.push(ms); },
  });

  await power._recover();

  assert.deepEqual(rounds, [
    { ids: ['agent-ok', 'agent-retry'], options: { concurrency: 2, staggerMs: 25 } },
    { ids: ['agent-retry'], options: { concurrency: 2, staggerMs: 25 } },
  ]);
  assert.deepEqual(delays, [10]);
});

test('PowerManager coalesces overlapping resume recovery tasks', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let starts = 0;
  let stops = 0;
  const manager = {
    workers: new Map([['old-1', {}]]),
    async stop() { stops += 1; },
    async start() { return { connected: true }; },
    async startMany(entries) {
      starts += 1;
      await gate;
      return entries.map(entry => ({ agentId: entry.agentId, connected: true }));
    },
  };
  const db = {
    prepare() {
      return {
        get: () => ({ data: '{}' }),
        all: () => [{ agent_id: 'agent-1', imUid: 'uid-1', imToken: 'token-1', im_server_url: 'wss://wukongim.vokovoko.com' }],
      };
    },
  };
  const power = new PowerManager(manager, db, { networkProbe: async () => true });
  const first = power._recover();
  const second = power._recover();
  release();
  await Promise.all([first, second]);

  assert.equal(stops, 1);
  assert.equal(starts, 1);
});

test('PowerManager keeps retrying failed IM connections in the background', async () => {
  let rounds = 0;
  const manager = {
    workers: new Map(),
    async stop() {},
    async start() { return { connected: false }; },
    getStatus() { return { connected: false }; },
    async startMany(entries) {
      rounds += 1;
      return entries.map(entry => ({ agentId: entry.agentId, connected: rounds > 1 }));
    },
  };
  const db = {
    prepare() {
      return {
        get: () => ({ data: '{}' }),
        all: () => [{ agent_id: 'agent-1', imUid: 'uid-1', imToken: 'token-1', im_server_url: 'wss://wukongim.vokovoko.com' }],
      };
    },
  };
  const power = new PowerManager(manager, db, {
    checkInterval: 60000,
    recoveryAttempts: 1,
    failedRetryDelayMs: 1,
    networkProbe: async () => true,
  });
  power.start();
  await power._recover();
  await new Promise(resolve => setTimeout(resolve, 20));
  power.stop();

  assert.equal(rounds, 2);
});

test('Lite profile update sends signed fields and persists the server category label', async (t) => {
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        get() {
          return {
            did: 'did:test:agent-1',
            private_key: TEST_PRIVATE_KEY,
          };
        },
        run(...args) { writes.push({ sql, args }); },
      };
    },
  };
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { json: async () => ({ success: true, data: { categoryLabel: 'Legal' } }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await updateAgentProfile({
    db,
    agentId: 'agent-1',
    name: 'Agent One',
    category: 'legal',
    tags: ['contract'],
  });
  assert.equal(result.success, true);
  assert.equal(body.name, 'Agent One');
  assert.equal(body.category, 'legal');
  assert.equal(typeof body.signature, 'string');
  assert.match(writes[0].sql, /category_label = \?/);
  assert.ok(writes[0].args.includes('Legal'));
});

test('Lite user-token capability search preserves pagination and response shape', async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { json: async () => ({ success: true, data: [{ id: 'agent-2' }], page: 2, count: 1 }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await searchCapabilitiesByUserToken({ token: 'ut_test', keyword: 'legal', page: '2', limit: '500' });
  assert.deepEqual(
    { ...result, onlineStatus: { ...result.onlineStatus, checkedAt: typeof result.onlineStatus.checkedAt } },
    { success: true, data: [{ id: 'agent-2' }], page: 2, count: 1, onlineStatus: { source: 'agentdid_search', checkedAt: 'number' } },
  );
  assert.match(request.url, /\/api\/external\/v1\/agents\/search$/);
  assert.equal(JSON.parse(request.options.body).limit, 100);
  assert.equal(request.options.headers.Authorization, 'Bearer ut_test');
  assert.equal(request.options.headers['X-Signature'], undefined);
});

test('Lite user-token capability search classifies invalid external API responses', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const cases = [
    {
      response: { ok: false, status: 401, json: async () => ({ success: false, message: 'unauthorized' }) },
      error: /unauthorized/,
    },
    {
      response: { ok: false, status: 500, json: async () => ({ success: false }) },
      error: /HTTP 500/,
    },
    {
      response: { ok: false, status: 502, json: async () => { throw new SyntaxError('HTML'); } },
      error: /JSON/i,
    },
    {
      response: { ok: true, status: 200, json: async () => ({ data: [] }) },
      error: /结构|response/i,
    },
  ];

  for (const item of cases) {
    global.fetch = async () => item.response;
    await assert.rejects(searchCapabilitiesByUserToken({ token: 'ut_test', keyword: 'test' }), item.error);
  }

  global.fetch = async () => { throw new Error('network unavailable'); };
  await assert.rejects(searchCapabilitiesByUserToken({ token: 'ut_test', keyword: 'test' }), /network unavailable/);
});

test('Lite capability search exposes a stable code for expired authentication', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ success: false, message: 'unauthorized' }),
  });
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    searchCapabilitiesByUserToken({ token: 'ut_expired', keyword: 'codex' }),
    error => error.code === 'SEARCH_AUTH_REQUIRED' && error.status === 401,
  );
});

test('Lite registration preview classifies external API response failures', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const db = {
    prepare() {
      return {
        get() { return undefined; },
        run() {},
      };
    },
  };
  const registration = createAgentRegistration({ db });
  const cases = [
    {
      response: { ok: false, status: 400, text: async () => '{"success":false,"message":"bad code"}' },
      error: /bad code/,
    },
    {
      response: { ok: false, status: 500, text: async () => '{"success":false}' },
      error: /HTTP 500/,
    },
    {
      response: { ok: false, status: 502, text: async () => '<html>bad gateway</html>' },
      error: /JSON/i,
    },
    {
      response: { ok: true, status: 200, text: async () => '{"agents":[]}' },
      error: /结构|response/i,
    },
  ];

  for (const item of cases) {
    global.fetch = async () => item.response;
    const result = await registration.verifyCodePreview({ email: 'owner@example.com', code: '123456' });
    assert.equal(result.success, false);
    assert.match(result.error, item.error);
  }

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '{"success":true,"agents":[{"agentId":"agent-1"}],"userExists":true}',
  });
  assert.deepEqual(
    await registration.verifyCodePreview({ email: 'owner@example.com', code: '123456' }),
    { success: true, agents: [{ agentId: 'agent-1' }], userExists: true },
  );

  global.fetch = async () => { throw new Error('network unavailable'); };
  assert.deepEqual(
    await registration.verifyCodePreview({ email: 'owner@example.com', code: '123456' }),
    { success: false, error: 'network unavailable' },
  );
});

test('Lite send-code and login bootstrap requests do not expose HMAC credentials', async (t) => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(' '));
  t.after(() => {
    global.fetch = originalFetch;
    console.log = originalLog;
  });
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (String(url).endsWith('/send-code')) {
      return { ok: true, status: 200, text: async () => '{"success":true}' };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '{"success":true,"data":{"userAccessToken":"ut_test","email":"owner@example.com","agents":[]}}',
    };
  };
  const db = {
    prepare() {
      return { get() { return undefined; }, run() {} };
    },
  };
  const registration = createAgentRegistration({ db });
  assert.equal((await registration.sendCode({ email: 'owner@example.com' })).success, true);
  assert.equal((await registration.loginByCode({ email: 'owner@example.com', code: '123456' })).success, true);
  for (const request of requests) {
    assert.deepEqual(request.options.headers, { 'Content-Type': 'application/json' });
  }
  const output = logs.join('\n');
  assert.doesNotMatch(output, /owner@example\.com|123456|ut_test/);
});

test('Lite send-code surfaces a business failure even when the server responds HTTP 200', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      success: false,
      code: 'EMAIL_DELIVERY_FAILED',
      message: 'Verification email delivery failed',
    }),
  });
  const db = {
    prepare() { return { get() { return undefined; }, run() {} }; },
  };

  const result = await createAgentRegistration({ db }).sendCode({ email: 'owner@example.com' });
  assert.deepEqual(result, {
    success: false,
    status: 200,
    code: 'EMAIL_DELIVERY_FAILED',
    error: 'Verification email delivery failed',
  });
});

test('Lite OAuth login follows the server session contract and persists only the VOKO token', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requests = [];
  const writes = [];
  const responses = [
    [200, { success: true, data: { providers: [{ id: 'google', enabled: true }] } }],
    [201, { success: true, data: { sessionId: 'los_test', authorizeUrl: 'https://example.test/auth' } }],
    [200, { success: true, data: { status: 'authorized', exchangeCode: 'loe_test' } }],
    [200, { success: true, data: { userAccessToken: 'ut_oauth_test', email: 'Owner@Example.com', scopes: ['agent:manage'] } }],
  ];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const [status, body] = responses.shift();
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const db = {
    prepare(sql) {
      return {
        get() { return undefined; },
        run(...args) { writes.push({ sql, args }); },
      };
    },
  };
  const registration = createAgentRegistration({ db });
  assert.equal((await registration.getOAuthProviders()).success, true);
  assert.equal((await registration.startOAuthSession({ provider: 'google' })).success, true);
  assert.equal((await registration.getOAuthSession({ sessionId: 'los_test' })).success, true);
  assert.deepEqual(
    await registration.exchangeOAuthSession({ sessionId: 'los_test', exchangeCode: 'loe_test' }),
    { success: true, email: 'owner@example.com', scopes: ['agent:manage'] },
  );
  assert.match(requests[0].url, /\/api\/auth\/lite\/oauth\/providers$/);
  assert.equal(JSON.parse(requests[1].options.body).provider, 'google');
  assert.equal(JSON.parse(requests[3].options.body).exchangeCode, 'loe_test');
  assert.equal(writes.length, 2);
  assert.match(String(writes[0].args[1]), /ut_oauth_test/);
  assert.equal(writes[1].args[0], 'current_user_email');
  assert.doesNotMatch(JSON.stringify(requests), /ut_oauth_test/);
});

test('Lite registration rejects incomplete credential responses before persistence', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        get() { return undefined; },
        run(...args) { writes.push({ sql, args }); },
      };
    },
  };
  const registration = createAgentRegistration({ db });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      success: true,
      agentId: 'agent-1',
      did: 'did:test:agent-1',
      publicKey: 'public-key',
      privateKey: '',
      imUid: 'agent-im-1',
      imToken: 'im-token-1',
      agents: [{ agentId: 'agent-1' }],
    }),
  });

  const result = await registration.verifyCode({
    email: 'owner@example.com',
    code: '123456',
    agentName: 'Agent 1',
  });

  assert.equal(result.success, false);
  assert.match(result.error, /结构|response/i);
  assert.equal(writes.length, 0);
});

test('Lite registration logs response status without credential bodies', async (t) => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const logs = [];
  t.after(() => {
    global.fetch = originalFetch;
    console.log = originalLog;
  });
  console.log = (...args) => logs.push(args.join(' '));
  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({
      success: false,
      privateKey: '<redacted>',
      imToken: '<redacted>',
      userAccessToken: '<redacted>',
    }),
  });
  const db = {
    prepare() {
      return {
        get() { return undefined; },
        run() {},
      };
    },
  };

  await createAgentRegistration({ db }).verifyCode({
    email: 'owner@example.com',
    code: '123456',
  });

  const output = logs.join('\n');
  assert.match(output, /response status: 400/);
  assert.doesNotMatch(output, /<redacted>/);
});

test('Lite capability registration merges declared and assigned skills', async (t) => {
  const db = createCapabilityDb();
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { json: async () => ({ success: true }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await registerCapabilitiesForAgent({
    db,
    agentId: 'agent-1',
  });
  assert.equal(result.success, true);
  assert.deepEqual(body.normalCapabilities, ['chat']);
  assert.ok(body.capabilities.some((item) => item.name === 'custom'));
  assert.ok(body.capabilities.some((item) => item.name === 'chat'));
  assert.equal('discoverable' in body, false);
  assert.match(db.writes[0].sql, /cap_error = NULL/);
});

test('Lite capability registration classifies invalid external API responses', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const cases = [
    {
      response: { ok: false, status: 400, json: async () => ({ success: false, message: 'bad capability' }) },
      error: 'bad capability',
    },
    {
      response: { ok: false, status: 500, json: async () => ({ success: false }) },
      error: /HTTP 500/,
    },
    {
      response: { ok: false, status: 502, json: async () => { throw new SyntaxError('HTML'); } },
      error: /JSON/i,
    },
    {
      response: { ok: true, status: 200, json: async () => ({ message: 'missing success' }) },
      error: /结构|response/i,
    },
  ];

  for (const item of cases) {
    const db = createCapabilityDb();
    global.fetch = async () => item.response;
    const result = await registerCapabilitiesForAgent({ db, agentId: 'agent-1' });
    assert.equal(result.success, false);
    if (typeof item.error === 'string') assert.equal(result.error, item.error);
    else assert.match(result.error, item.error);
    assert.match(db.writes.at(-1).sql, /cap_error = \?/);
  }

  const networkDb = createCapabilityDb();
  global.fetch = async () => { throw new Error('network unavailable'); };
  assert.deepEqual(
    await registerCapabilitiesForAgent({ db: networkDb, agentId: 'agent-1' }),
    { success: false, error: 'network unavailable' },
  );
  assert.match(networkDb.writes.at(-1).sql, /cap_error = \?/);
});

test('Lite scheduler coalesces wakeups and creates recovery actions on token limits', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agent_wakeup_requests (
      id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, reason TEXT,
      idempotency_key TEXT, payload TEXT, status TEXT,
      coalesced_count INTEGER, created_at INTEGER, updated_at INTEGER
    )
  `);
  try {
    const scheduler = createScheduler(db);
    const first = scheduler.wakeup.enqueue('agent-1', {
      source: 'message',
      idempotencyKey: 'message-1',
      payload: { text: 'hello' },
    });
    const duplicate = scheduler.wakeup.enqueue('agent-1', {
      source: 'message',
      idempotencyKey: 'message-1',
    });
    assert.equal(first.coalesced, false);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.coalesced, true);
    assert.deepEqual(scheduler.wakeup.dequeue('agent-1').payload, { text: 'hello' });
    scheduler.wakeup.complete(first.id);

    for (let i = 0; i < 11; i++) scheduler.tokenGuard.record('agent-1', 'visitor-1', {});
    assert.deepEqual(scheduler.tokenGuard.check('agent-1', 'visitor-1'), {
      limited: true,
      reason: 'agent_rate_limit',
    });
    assert.equal(scheduler.recovery.listOpen('agent-1').length, 1);
  } finally {
    db.close();
  }
});

test('Lite watchdog emits a timeout once and removes the expired session', async (t) => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const timeouts = [];
  const watchdog = createWatchdog({
    onSessionTimeout: (info) => timeouts.push(info),
  });
  watchdog.feed('agent-1', 'visitor:with:colon');
  now += 300001;
  watchdog.start(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  watchdog.stop();

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].visitorId, 'visitor:with:colon');
  assert.equal(watchdog.getStatus().sessions.length, 0);
});

test('Lite auto-updater compares versions and verifies sha512 integrity deterministically', () => {
  assert.equal(autoUpdater.compareVersions('0.3.7', '0.3.6'), 1);
  assert.equal(autoUpdater.compareVersions('0.3.7', '0.3.7.0'), 0);
  assert.equal(autoUpdater.compareVersions('0.3.7', '0.4.0'), -1);
  const payload = Buffer.from('voko-lite-tarball');
  const digest = require('node:crypto').createHash('sha512').update(payload).digest('base64');
  assert.equal(autoUpdater.verifyIntegrity(payload, `sha512-${digest}`), true);
  assert.equal(autoUpdater.verifyIntegrity(payload, 'sha512-invalid'), false);
  assert.equal(autoUpdater.verifyIntegrity(payload, ''), false);
});

test('Lite offline sync decodes, persists and forwards a pulled message', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.start_message_seq, 8);
    assert.equal(options.headers.Authorization, 'Bearer ut_owner');
    assert.equal(options.headers['X-Voko-Agent-Uid'], 'agent-uid');
    return {
      ok: true,
      json: async () => ({
        messages: [{
          message_id: 'message-8',
          message_seq: 8,
          from_uid: 'visitor-1',
          payload: Buffer.from(JSON.stringify({ content: 'offline hello', type: 1 })).toString('base64'),
          timestamp: 123,
        }],
      }),
    };
  };
  t.after(() => { global.fetch = originalFetch; });
  const db = {
    exec() {},
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM agents')) {
            return [{ agent_id: 'agent-1', imUid: 'agent-uid', imToken: 'token', im_server_url: 'ws://im.test:5200', owner_email: 'owner@example.test' }];
          }
          if (sql.includes('FROM conversations')) return [{ channel_id: 'visitor-1' }];
          return [];
        },
        get() {
          if (sql.includes("type = ?")) {
            return { data: JSON.stringify({ 'owner@example.test': { user_access_token: 'ut_owner' } }) };
          }
          return { m: 7 };
        },
        run() {},
      };
    },
  };
  const forwarded = [];
  const handler = {
    handleAgentMessage(agentId, data, skipForward) {
      assert.equal(skipForward, true);
      return {
        agentId,
        fromUid: data.fromUid,
        channelId: data.channelId,
        channelType: data.channelType,
        content: data.content,
        contentType: data.contentType,
        messageId: data.messageId,
        timestamp: data.timestamp,
      };
    },
    forwardToAgent(...args) { forwarded.push(args); },
  };

  assert.equal(await syncOfflineMessages(db, handler, 'agent-1'), 1);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0][2], 'offline hello');
  assert.equal(forwarded[0][3], 'visitor-1');
});

test('Lite offline sync advances past an intentionally skipped empty message', async (t) => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const starts = [];
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    starts.push(request.start_message_seq);
    return {
      ok: true,
      json: async () => ({
        messages: request.start_message_seq === 1 ? [{
          message_id: 'empty-1',
          message_seq: 1,
          from_uid: 'visitor-1',
          content: '',
          timestamp: 123,
        }] : [],
      }),
    };
  };
  t.after(() => { global.fetch = originalFetch; console.log = originalLog; });

  let cursorData;
  const db = {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM agents')) {
            return [{ agent_id: 'agent-1', imUid: 'agent-uid', owner_email: 'owner@example.test' }];
          }
          if (sql.includes('FROM conversations')) return [{ channel_id: 'visitor-1' }];
          return [];
        },
        get() {
          if (sql === 'SELECT data FROM config WHERE type=?') {
            return cursorData ? { data: cursorData } : undefined;
          }
          if (sql.includes('SELECT MAX(message_seq)')) return { m: null };
          if (sql.includes('type = ?')) {
            return { data: JSON.stringify({ 'owner@example.test': { user_access_token: 'ut_owner' } }) };
          }
          return undefined;
        },
        run(type, data) {
          if (sql.includes('INSERT OR REPLACE INTO config') && type === 'offline_sync_cursors') {
            cursorData = data;
          }
        },
      };
    },
  };
  let handled = 0;
  const handler = {
    handleAgentMessage() {
      handled++;
      return undefined;
    },
    forwardToAgent() {},
  };

  assert.equal(await syncOfflineMessages(db, handler, 'agent-1'), 1);
  assert.equal(await syncOfflineMessages(db, handler, 'agent-1'), 0);
  assert.deepEqual(starts, [1, 2]);
  assert.equal(handled, 1);
  // 有消息的轮次保留汇总；空轮次不再输出重复的“收集 0 条”日志。
  const summaryLogs = logs.filter(log => log.includes('[离线同步] 完成'));
  assert.ok(summaryLogs.length >= 1, '应有汇总日志');
  assert.equal(summaryLogs.some(log => /收集 0 条/.test(log)), false, '空轮次不应产生重复汇总噪音');
});

test('Lite offline sync only pulls published Agents owned by the current local user', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ messages: [] }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const db = {
    exec() {},
    prepare(sql) {
      return {
        all(arg) {
          if (sql.includes('FROM agents')) {
            return [
              { agent_id: 'local-agent', imUid: 'local-uid', imToken: 'local-token', im_server_url: 'ws://im.test:5200', owner_email: 'owner@example.test' },
              { agent_id: 'remote-agent', imUid: 'remote-uid', imToken: 'remote-token', im_server_url: 'ws://im.test:5200', owner_email: 'other@example.test' },
            ].filter((agent) => !sql.includes('LOWER(TRIM(owner_email))') || agent.owner_email === arg);
          }
          if (sql.includes('FROM conversations')) return [{ channel_id: `visitor-${arg}` }];
          return [];
        },
        get(key) {
          if (sql.includes('FROM config') && key === 'user_access_token') {
            return { data: JSON.stringify({ 'owner@example.test': { user_access_token: 'ut_owner' } }) };
          }
          if (sql.includes('FROM config') && key === 'current_user_email') {
            return { data: JSON.stringify('owner@example.test') };
          }
          if (sql.includes('SELECT MAX(message_seq)')) return { m: 0 };
          return undefined;
        },
        run() {},
      };
    },
  };
  const handler = { handleAgentMessage() { return undefined; }, forwardToAgent() {} };

  assert.equal(await syncOfflineMessages(db, handler), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.login_uid, 'local-uid');
  assert.equal(requests[0].body.channel_id, 'visitor-local-agent');
});

test('Lite offline sync does nothing when no local user is authenticated', async (t) => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error('must not fetch'); };
  t.after(() => { global.fetch = originalFetch; });

  const db = {
    prepare(sql) {
      return {
        all() { assert.fail(`agents must not be queried: ${sql}`); },
        get() { return undefined; },
        run() {},
      };
    },
  };
  const handler = { handleAgentMessage() { return undefined; }, forwardToAgent() {} };

  assert.equal(await syncOfflineMessages(db, handler), 0);
  assert.equal(fetchCalls, 0);
});

test('Lite offline sync stops an in-flight old-owner run after account switching', async (t) => {
  const originalFetch = global.fetch;
  let activeOwner = 'owner-a@example.test';
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(options.headers.Authorization);
    activeOwner = 'owner-b@example.test';
    return { ok: true, json: async () => ({ messages: [{ message_id: 'must-not-process' }] }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const db = {
    exec() {},
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM agents')) return [
            { agent_id: 'agent-a', imUid: 'uid-a', owner_email: 'owner-a@example.test' },
            { agent_id: 'agent-a2', imUid: 'uid-a2', owner_email: 'owner-a@example.test' },
          ];
          if (sql.includes('FROM conversations')) return [{ channel_id: 'visitor-a' }];
          return [];
        },
        get(key) {
          if (sql.includes('FROM config') && key === 'current_user_email') return { data: JSON.stringify(activeOwner) };
          if (sql.includes('FROM config') && key === 'user_access_token') return { data: JSON.stringify({
            'owner-a@example.test': { user_access_token: 'ut_owner_a' },
            'owner-b@example.test': { user_access_token: 'ut_owner_b' },
          }) };
          if (sql.includes('SELECT MAX(message_seq)')) return { m: 0 };
          return undefined;
        },
        run() {},
      };
    },
  };
  let handled = 0;
  const handler = { handleAgentMessage() { handled += 1; }, forwardToAgent() {} };

  assert.equal(await syncOfflineMessages(db, handler), 0);
  assert.deepEqual(requests, ['Bearer ut_owner_a']);
  assert.equal(handled, 0);
});

test('Lite offline sync only pulls published Agents owned by the current local user', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ messages: [] }) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const db = {
    exec() {},
    prepare(sql) {
      return {
        all(arg) {
          if (sql.includes('FROM agents')) {
            return [
              { agent_id: 'local-agent', imUid: 'local-uid', imToken: 'local-token', im_server_url: 'ws://im.test:5200', owner_email: 'owner@example.test' },
              { agent_id: 'remote-agent', imUid: 'remote-uid', imToken: 'remote-token', im_server_url: 'ws://im.test:5200', owner_email: 'other@example.test' },
            ].filter((agent) => !sql.includes('LOWER(TRIM(owner_email))') || agent.owner_email === arg);
          }
          if (sql.includes('FROM conversations')) return [{ channel_id: `visitor-${arg}` }];
          return [];
        },
        get(key) {
          if (sql.includes('FROM config') && key === 'user_access_token') {
            return { data: JSON.stringify({ 'owner@example.test': { user_access_token: 'ut_owner' } }) };
          }
          if (sql.includes('FROM config') && key === 'current_user_email') {
            return { data: JSON.stringify('owner@example.test') };
          }
          if (sql.includes('SELECT MAX(message_seq)')) return { m: 0 };
          return undefined;
        },
        run() {},
      };
    },
  };
  const handler = { handleAgentMessage() { return undefined; }, forwardToAgent() {} };

  assert.equal(await syncOfflineMessages(db, handler), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.login_uid, 'local-uid');
  assert.equal(requests[0].body.channel_id, 'visitor-local-agent');
});

test('Lite offline sync does nothing when no local user is authenticated', async (t) => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error('must not fetch'); };
  t.after(() => { global.fetch = originalFetch; });

  const db = {
    prepare(sql) {
      return {
        all() { assert.fail(`agents must not be queried: ${sql}`); },
        get() { return undefined; },
        run() {},
      };
    },
  };
  const handler = { handleAgentMessage() { return undefined; }, forwardToAgent() {} };

  assert.equal(await syncOfflineMessages(db, handler), 0);
  assert.equal(fetchCalls, 0);
});

test('Lite delivery uses the shared Hub and awaits SENDACK metadata', async () => {
  const calls = [];
  const deliver = createDeliver({
    transportManager: {
      async deliver(...args) {
        calls.push(args);
        return { success: true, messageId: 'remote-1', messageSeq: 7, clientMsgNo: args[6] };
      },
    },
  });
  const result = await deliver('agent-1', 'visitor-1', 'hello', 'text', 1, null, 'local-1');
  assert.equal(result.success, true);
  assert.equal(result.via, 'hub');
  assert.equal(result.messageId, 'local-1');
  assert.equal(result.serverMessageId, 'remote-1');
  assert.equal(result.messageSeq, 7);
  assert.equal(result.clientMsgNo, 'local-1');
  assert.equal(calls.length, 1);
});

test('secure delivery proxy changes every shared private-delivery caller without replacing raw delivery', async () => {
  const rawCalls=[];const secureCalls=[];
  const raw=async(...args)=>{rawCalls.push(args);return{success:true,messageId:args[6]};};
  const proxy=createSecureDeliverProxy(raw);
  await proxy('agent-1','visitor-1','plain','text',1,null,'plain-1');
  proxy.setSecureRouter({deliver:async(...args)=>{secureCalls.push(args);return{success:true,messageId:args[6],
    securityMode:'e2ee',securityReason:'recipient_supported',encryptedDeviceCount:1,deliveryState:'delivered'};}});
  const protectedResult=await proxy('agent-1','visitor-1','secret','text',1,null,'secure-1');
  await proxy.rawDeliver('agent-1','visitor-1','fixed-envelope','text',1,null,'raw-2');
  assert.equal(protectedResult.securityMode,'e2ee');
  assert.equal(secureCalls.length,1);
  assert.equal(rawCalls.length,2);
});

test('Lite send-message keeps partial multi-device E2EE delivery pending', async () => {
  const statusWrites=[];
  const db={prepare(sql){return{get(){return sql.includes('SELECT imUid')?{imUid:'agent-uid'}:undefined;},
    run(...args){if(sql.includes('message_seq=COALESCE'))statusWrites.push(args);}};}};
  const send=createSendMessage({db,deliver:async(...args)=>({success:true,messageId:args[6],securityMode:'e2ee',
    securityReason:'recipient_supported',encryptedDeviceCount:2,deliveryState:'partial'})});
  const result=await send('agent-1','visitor-1','private','agent-uid','text',1);
  assert.equal(result.deliveryState,'partial');
  assert.equal(statusWrites.at(-1)[0],'pending');
});

test('Lite send-message normalizes content, persists it and passes the local id to delivery', async () => {
  const writes = [];
  const db = {
    exec() {},
    prepare(sql) {
      return {
        get() {
          if (sql.includes('SELECT imUid')) return { imUid: 'agent-uid' };
          return undefined;
        },
        run(...args) { writes.push({ sql, args }); },
      };
    },
  };
  const deliveries = [];
  const send = createSendMessage({
    db,
    deliver: async (...args) => {
      deliveries.push(args);
      return { success: true, messageId: args[6], messageSeq: 9, clientMsgNo: 'client-9' };
    },
  });
  const result = await send('agent-1', 'visitor-1', 'line1\\nline2', 'agent-uid', 'text', 1);
  assert.equal(result.success, true);
  assert.equal(result.messageSeq, 9);
  assert.equal(deliveries[0][2], 'line1\nline2');
  assert.match(deliveries[0][6], /^msg-agent-1-visitor-1-/);
  assert.ok(writes.some((entry) => entry.sql.includes('INSERT INTO messages')));
  assert.ok(writes.some((entry) => entry.sql.includes('INSERT INTO conversations')));
  assert.ok(writes.some((entry) => entry.sql.includes('message_seq=COALESCE') && entry.sql.includes('client_msg_no=COALESCE')));
});

test('Lite send-message returns the routable local id and keeps the remote ACK id separate', async () => {
  const db = {
    prepare(sql) {
      return {
        get() { return sql.includes('SELECT imUid') ? { imUid: 'agent-uid' } : undefined; },
        run() {},
      };
    },
  };
  const send = createSendMessage({
    db,
    deliver: async (...args) => ({
      success: true,
      messageId: args[6],
      serverMessageId: 'remote-ack-1',
      clientMsgNo: args[6],
    }),
  });
  const result = await send('agent-1', 'visitor-1', 'attachment', 'agent-uid', 'file', 1);
  assert.match(result.messageId, /^msg-agent-1-visitor-1-/);
  assert.equal(result.serverMessageId, 'remote-ack-1');
});

test('Lite payment processing claims once, creates a remote order and sends its link', async (t) => {
  const updates = [];
  const sent = [];
  let createBody;
  const db = {
    exec() {},
    prepare(sql) {
      return {
        get() {
          if (sql.includes('private_key')) {
            return { private_key: TEST_PRIVATE_KEY };
          }
          return { imUid: 'agent-uid' };
        },
        run() {
          return sql.includes("status = 'processing'") ? { changes: 1 } : { changes: 1 };
        },
        all() { return []; },
      };
    },
  };
  const databaseAPI = {
    getAgentDid: () => 'did:test:agent-1',
    updatePaymentOrder: (id, update) => updates.push({ id, update }),
    getPaymentOrdersByStatus: () => [],
    saveOwnerIntervention() {},
  };
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    createBody = JSON.parse(options.body);
    return ({
    ok: true,
    json: async () => ({
      success: true,
      data: { payUrl: 'https://pay.test/order-1', orderNo: 'order-1', queryToken: 'query-1' },
    }),
  }); };
  t.after(() => { global.fetch = originalFetch; });

  const result = await processPendingPaymentOrder({
    id: 'local-1',
    agent_id: 'agent-1',
    visitor_id: 'visitor-1',
    amount: 12.5,
    description: 'consulting',
  }, {
    db,
    databaseAPI,
    endpoints: { payment: { baseUrl: 'https://pay.test' } },
    sendMessage: async (...args) => {
      assert.equal(updates.at(-1)?.update.status, 'created');
      sent.push(args);
      return { success: true, deliveryState: 'delivered', messageId: args[7] };
    },
  });

  assert.equal(createBody.clientOrderId, 'local-1');
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /12\.50/);
  assert.match(sent[0][2], /https:\/\/pay\.test\/order-1/);
  assert.deepEqual(updates.at(-1), {
    id: 'local-1',
    update: { status: 'created', order_no: 'order-1', pay_url: 'https://pay.test/order-1' },
  });
  assert.equal(result.orderCreated, true);
  assert.equal(result.sentToVisitor, true);
  assert.equal(result.deliveryStatus, 'delivered');
  assert.equal(result.visitorId, 'visitor-1');
  assert.match(result.messageId, /^pay_msg_/);
});

test('Lite payment processing reports pending and failed visitor delivery explicitly', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => ({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        payUrl: `https://pay.test/${JSON.parse(options.body).clientOrderId}`,
        orderNo: `remote-${JSON.parse(options.body).clientOrderId}`,
        queryToken: 'query-1',
      },
    }),
  });
  t.after(() => { global.fetch = originalFetch; });

  const runCase = async (id, sendResult) => {
    const updates = [];
    const db = {
      exec() {},
      prepare(sql) {
        return {
          get: () => sql.includes('private_key') ? { private_key: TEST_PRIVATE_KEY } : { imUid: 'agent-uid' },
          run: () => ({ changes: 1 }),
          all: () => [],
        };
      },
    };
    const result = await processPendingPaymentOrder({
      id, agent_id: 'agent-1', visitor_id: 'visitor-1', amount: 1, description: 'test',
    }, {
      db,
      databaseAPI: {
        getAgentDid: () => 'did:test:agent-1',
        updatePaymentOrder: (orderId, update) => updates.push({ orderId, update }),
        getPaymentOrdersByStatus: () => [],
        saveOwnerIntervention() {},
      },
      endpoints: { payment: { baseUrl: 'https://pay.test' } },
      sendMessage: async () => sendResult,
    });
    return { result, updates };
  };

  const pending = await runCase('pending-1', { success: true, deliveryState: 'pending', messageId: 'msg-pending' });
  assert.equal(pending.result.orderCreated, true);
  assert.equal(pending.result.sentToVisitor, false);
  assert.equal(pending.result.deliveryStatus, 'pending');
  assert.equal(pending.result.messageId, 'msg-pending');
  assert.equal(pending.updates.at(-1).update.result, undefined);

  const failed = await runCase('failed-1', { success: false, error: 'SENDACK rejected', messageId: 'msg-failed' });
  assert.equal(failed.result.orderCreated, true);
  assert.equal(failed.result.sentToVisitor, false);
  assert.equal(failed.result.deliveryStatus, 'failed');
  assert.equal(failed.result.error, 'SENDACK rejected');
  assert.deepEqual(failed.updates.at(-1).update, {
    status: 'created',
    order_no: 'remote-failed-1',
    pay_url: 'https://pay.test/failed-1',
    result: 'SENDACK rejected',
  });
});

test('Lite payment processing skips an order that was already claimed', async () => {
  let fetched = false;
  const db = {
    exec() {},
    prepare() {
      return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    },
  };
  const originalFetch = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  try {
    await processPendingPaymentOrder({
      id: 'local-1', agent_id: 'agent-1', visitor_id: 'visitor-1', amount: 1,
    }, {
      db,
      databaseAPI: {
        getAgentDid: () => null,
        updatePaymentOrder() {},
        getPaymentOrdersByStatus: () => [],
        saveOwnerIntervention() {},
      },
      endpoints: { payment: { baseUrl: 'https://pay.test' } },
    });
    assert.equal(fetched, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Lite payment polling returns a repeat-safe stop function', (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduled = [];
  const cleared = [];
  global.setTimeout = (fn, delay) => {
    const token = { fn, delay };
    scheduled.push(token);
    return token;
  };
  global.clearTimeout = (token) => { cleared.push(token); };
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });
  const stop = startPaymentPolling({
    db: { exec() {}, prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) },
    databaseAPI: {
      getAgentDid: () => null,
      updatePaymentOrder() {},
      getPaymentOrdersByStatus: () => [],
      saveOwnerIntervention() {},
    },
    endpoints: { payment: { baseUrl: 'https://pay.test' } },
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 5000);
  stop();
  stop();
  assert.equal(cleared.length, 2);
});

test('Lite payment polling does not query an order without queryToken', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalFetch = global.fetch;
  const scheduled = [];
  const updates = [];
  let fetched = false;
  global.setTimeout = (fn, delay) => {
    const token = { fn, delay };
    scheduled.push(token);
    return token;
  };
  global.fetch = async () => {
    fetched = true;
    throw new Error('must not fetch without queryToken');
  };
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.fetch = originalFetch;
  });
  const order = {
    id: 'legacy-no-token', agent_id: 'agent-1', visitor_id: 'visitor-1',
    order_no: 'remote-1', amount: 1, status: 'created',
  };
  const stop = startPaymentPolling({
    db: {
      exec() {},
      prepare(sql) {
        return {
          get: () => sql.includes('query_token') ? { query_token: null } : undefined,
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      },
    },
    databaseAPI: {
      getAgentDid: () => null,
      updatePaymentOrder: (id, update) => updates.push({ id, update }),
      getPaymentOrdersByStatus: (status) => status === 'created' ? [order] : [],
      saveOwnerIntervention() {},
    },
    endpoints: { payment: { baseUrl: 'https://pay.test' } },
  });

  await scheduled[0].fn();
  stop();
  assert.equal(fetched, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'legacy-no-token');
  assert.equal(updates[0].update.status, 'failed');
  assert.match(updates[0].update.result, /queryToken/);
});

test('Lite payment polling trusts remote pending state over a legacy local expiry', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalFetch = global.fetch;
  const scheduled = [];
  const updates = [];
  global.setTimeout = (fn, delay) => {
    const token = { fn, delay };
    scheduled.push(token);
    return token;
  };
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, data: { status: 0 } }),
  });
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.fetch = originalFetch;
  });
  const order = {
    id: 'legacy-1', agent_id: 'agent-1', visitor_id: 'visitor-1',
    order_no: 'remote-1', amount: 1, status: 'expired',
  };
  const stop = startPaymentPolling({
    db: {
      exec() {},
      prepare(sql) {
        return {
          get: () => ({ query_token: 'q1' }),
          all: () => sql.includes("status = 'expired'") ? [order] : [],
          run: () => ({ changes: 0 }),
        };
      },
    },
    databaseAPI: {
      getAgentDid: () => null,
      updatePaymentOrder: (id, update) => updates.push({ id, update }),
      getPaymentOrdersByStatus: () => [],
      saveOwnerIntervention() {},
    },
    endpoints: { payment: { baseUrl: 'https://pay.test' } },
  });

  await scheduled[0].fn();
  stop();
  assert.deepEqual(updates, [{ id: 'legacy-1', update: { status: 'created' } }]);
});
