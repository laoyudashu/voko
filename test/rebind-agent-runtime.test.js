const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRebindAgentRuntime } = require('../build/core/rebind-agent-runtime');

// 构造一套可观测的 mock deps：记录每次调用，可编程返回值/抛错。
function makeDeps(overrides = {}) {
  const calls = {
    ensureBackend: [],
    invalidateMeta: [],
    invalidateBindings: [],
    restartAgentWorker: [],
    forcePull: [],
    getDeliveryStatus: [],
  };
  const deps = {
    ensureBackend: async (type) => {
      calls.ensureBackend.push(type);
      if (overrides.ensureBackendThrow) throw new Error(overrides.ensureBackendThrow);
    },
    invalidateMeta: (agentId) => { calls.invalidateMeta.push(agentId); },
    invalidateBindingsForConfigChange: (input) => {
      calls.invalidateBindings.push(input);
      if (overrides.invalidateBindingsThrow) throw new Error(overrides.invalidateBindingsThrow);
      return typeof overrides.invalidateBindingsReturn === 'number'
        ? overrides.invalidateBindingsReturn
        : 0;
    },
    getAgentDeliveryStatus: (agentId) => {
      calls.getDeliveryStatus.push(agentId);
      return overrides.deliveryStatus || { availableModes: ['push'], methods: [{ mode: 'push' }, { mode: 'pull' }] };
    },
    restartAgentWorker: async (agentId) => {
      calls.restartAgentWorker.push(agentId);
      if (overrides.restartThrow) throw new Error(overrides.restartThrow);
    },
    forceDeliveryModesPull: (db, agentId) => { calls.forcePull.push(agentId); },
  };
  return { deps, calls };
}

function snap(backendType, backendInstanceId, im = {}) {
  return { backendType, backendInstanceId: backendInstanceId ?? null, ...im };
}

describe('rebindAgentRuntime 核心逻辑', () => {
  it('prev==next（无变更）：rebindStatus=unchanged，不触发任何运行时操作', async () => {
    const { deps, calls } = makeDeps();
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap('hermes', 'p-a'), next: snap('hermes', 'p-a') });
    assert.equal(r.rebindStatus, 'unchanged');
    assert.equal(r.success, true);
    assert.equal(calls.ensureBackend.length, 0);
    assert.equal(calls.invalidateBindings.length, 0);
    assert.equal(calls.invalidateMeta.length, 0);
    assert.equal(calls.restartAgentWorker.length, 0);
    assert.ok(r.deliveryReadiness, 'unchanged 也应透传当前 deliveryStatus');
  });

  it('仅类型变（others→hermes）：ensureBackend 被调，全 agent 绑定失效，invalidateMeta 被调', async () => {
    const { deps, calls } = makeDeps({ invalidateBindingsReturn: 3 });
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap('others', null), next: snap('hermes', null) });
    assert.equal(r.rebindStatus, 'rebound');
    assert.equal(r.provider.action, 'loaded');
    assert.equal(r.provider.type, 'hermes');
    assert.deepEqual(calls.ensureBackend, ['hermes']);
    assert.equal(r.bindings.invalidated, 3);
    assert.equal(calls.invalidateBindings[0].prevProviderType, 'others');
    assert.equal(calls.invalidateBindings[0].nextProviderType, 'hermes');
    assert.deepEqual(calls.invalidateMeta, ['a1']);
  });

  it('仅实例变（hermes p-a→p-b）：不调 ensureBackend，仅按旧实例失效绑定', async () => {
    const { deps, calls } = makeDeps({ invalidateBindingsReturn: 1 });
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap('hermes', 'p-a'), next: snap('hermes', 'p-b') });
    assert.equal(r.rebindStatus, 'rebound');
    assert.equal(r.provider.action, 'unchanged'); // 类型没变，不需要加载
    assert.equal(calls.ensureBackend.length, 0);
    assert.equal(r.bindings.invalidated, 1);
    assert.equal(calls.invalidateBindings[0].prevInstanceId, 'p-a');
    assert.equal(calls.invalidateBindings[0].nextInstanceId, 'p-b');
  });

  it('类型+实例都变：ensureBackend 被调，绑定按类型变化全失效', async () => {
    const { deps, calls } = makeDeps({ invalidateBindingsReturn: 2 });
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap('hermes', 'p-a'), next: snap('openclaw', 'oc-1') });
    assert.equal(r.provider.action, 'loaded');
    assert.deepEqual(calls.ensureBackend, ['openclaw']);
    assert.equal(r.bindings.invalidated, 2);
  });

  it('仅 IM 凭证变：restartAgentWorker 被调，不调 ensureBackend，绑定不变', async () => {
    const { deps, calls } = makeDeps();
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({
      db: {}, agentId: 'a1',
      previous: snap('hermes', 'p-a', { imUid: 'u1', imToken: 't1', imServerUrl: 's1' }),
      next:     snap('hermes', 'p-a', { imUid: 'u2', imToken: 't1', imServerUrl: 's1' }),
    });
    assert.equal(r.rebindStatus, 'rebound');
    assert.equal(r.imWorker.action, 'restarted');
    assert.equal(calls.ensureBackend.length, 0);
    assert.equal(r.bindings.invalidated, 0); // type/instance 没变，不动绑定
    assert.deepEqual(calls.restartAgentWorker, ['a1']);
  });

  it('ensureBackend 抛错：provider.action=failed，forcePull 被调，delivery_modes 降级，不外抛', async () => {
    const { deps, calls } = makeDeps({ ensureBackendThrow: 'load failed' });
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap('others', null), next: snap('hermes', null) });
    assert.equal(r.rebindStatus, 'failed');
    assert.equal(r.success, false);
    assert.equal(r.provider.action, 'failed');
    assert.ok(r.error.includes('ensureBackend 失败'));
    assert.deepEqual(calls.forcePull, ['a1']);
    assert.deepEqual(calls.invalidateMeta, ['a1']); // 失败也清缓存
  });

  it('restartAgentWorker 抛错：imWorker.action=failed，但 rebindStatus 仍 rebound（IM 失败不阻塞）', async () => {
    const { deps, calls } = makeDeps({ restartThrow: 'worker boom' });
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({
      db: {}, agentId: 'a1',
      previous: snap('hermes', 'p-a', { imUid: 'u1' }),
      next:     snap('hermes', 'p-a', { imUid: 'u2' }),
    });
    assert.equal(r.rebindStatus, 'rebound');
    assert.equal(r.success, true);
    assert.equal(r.imWorker.action, 'failed');
    assert.ok(r.imWorker.status.includes('worker boom'));
  });

  it('无自动通道可用：fallback 标注 voko_fetch_new_messages', async () => {
    const { deps } = makeDeps({
      deliveryStatus: { availableModes: ['pull'], methods: [{ mode: 'pull' }] },
    });
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap('others', null), next: snap('hermes', null) });
    assert.equal(r.fallback, 'voko_fetch_new_messages');
  });

  it('invalidateBindings 抛错：不致命，rebind 继续，仍 rebound', async () => {
    const { deps, calls } = makeDeps({ invalidateBindingsThrow: 'db locked' });
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap('others', null), next: snap('hermes', null) });
    assert.equal(r.rebindStatus, 'rebound');
    assert.equal(r.bindings.invalidated, 0);
    assert.deepEqual(calls.invalidateMeta, ['a1']); // 后续步骤照常
  });

  it('空格/大小写差异被规范化（" hermes " == "hermes"）不误判为变更', async () => {
    const { deps, calls } = makeDeps();
    const rebind = createRebindAgentRuntime(deps);
    const r = await rebind({ db: {}, agentId: 'a1', previous: snap(' hermes ', 'p-a'), next: snap('hermes', 'p-a') });
    assert.equal(r.rebindStatus, 'unchanged');
    assert.equal(calls.ensureBackend.length, 0);
  });
});
