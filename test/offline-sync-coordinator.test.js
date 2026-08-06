const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createOfflineSyncCoordinator } = require('../build/core/offline-sync');

// 用受控的假 timer：维护一个虚拟时钟，fire(ms) 推进时钟并触发所有到期回调。
// 这样测试不依赖真实 500ms 等待，快且确定；且支持"部分推进"语义（fire(300) 后 fire(200) 累计 500ms）。
function makeFakeTimers() {
  const pending = []; // { id, fn, at }  at = 设定时的时钟 + ms
  let now = 0;
  let nextId = 1;
  const setTimeout = (fn, ms) => { const id = nextId++; pending.push({ id, fn, at: now + ms }); return id; };
  const clearTimeout = (id) => { const i = pending.findIndex(p => p.id === id); if (i >= 0) pending.splice(i, 1); };
  const fire = (ms) => {
    now += ms;
    // 复制一份再迭代，避免回调里新增/删除影响本轮
    const due = pending.filter(p => p.at <= now).slice();
    for (const p of due) { clearTimeout(p.id); p.fn(); }
  };
  const fireAll = () => { while (pending.length) { const p = pending[0]; clearTimeout(p.id); p.fn(); } };
  const pendingCount = () => pending.length;
  return { setTimeout, clearTimeout, fire, fireAll, pendingCount };
}

// 记录每次全量同步的调用，返回受控 syncFn。
function makeSyncFn() {
  const calls = [];
  const syncFn = async () => { calls.push(Date.now()); return 0; };
  return { syncFn, calls };
}

describe('createOfflineSyncCoordinator coalesce 行为', () => {
  it('500ms 窗口内多个 agent 连接合并为一次全量同步', () => {
    const timers = makeFakeTimers();
    const { syncFn, calls } = makeSyncFn();
    const coord = createOfflineSyncCoordinator({}, {}, {
      windowMs: 500, fallbackMs: 30000, syncFn,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });

    // 模拟 8 个 agent 几乎同时连上
    for (let i = 0; i < 8; i++) coord.onAgentConnected(`agent-${i}`);
    assert.equal(timers.pendingCount(), 1, '应只有一个合并定时器');
    assert.equal(calls.length, 0, '窗口内不立即同步');

    timers.fire(500); // 窗口到期
    assert.equal(calls.length, 1, '8 个连接合并为 1 次全量同步');
    timers.fireAll(); // 确保无残留
    assert.equal(calls.length, 1, '不应有额外同步');
  });

  it('窗口到期前再来的 agent 也并入同一批', () => {
    const timers = makeFakeTimers();
    const { syncFn, calls } = makeSyncFn();
    const coord = createOfflineSyncCoordinator({}, {}, {
      windowMs: 500, syncFn, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });

    coord.onAgentConnected('a1');
    timers.fire(300); // 未到期
    assert.equal(calls.length, 0);
    coord.onAgentConnected('a2'); // 并入同一窗口
    timers.fire(200); // 累计 500ms，到期
    assert.equal(calls.length, 1, '两个 agent 仍合并为 1 次');
  });

  it('分散的连接（间隔超过窗口）各触发一次', () => {
    const timers = makeFakeTimers();
    const { syncFn, calls } = makeSyncFn();
    const coord = createOfflineSyncCoordinator({}, {}, {
      windowMs: 500, syncFn, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });

    coord.onAgentConnected('a1');
    timers.fire(500);
    coord.onAgentConnected('a2');
    timers.fire(500);
    assert.equal(calls.length, 2, '两次独立窗口各 1 次同步');
  });

  it('onAllReady 只触发一次首次全量同步（守卫）', () => {
    const timers = makeFakeTimers();
    const { syncFn, calls } = makeSyncFn();
    const coord = createOfflineSyncCoordinator({}, {}, {
      windowMs: 500, fallbackMs: 30000, syncFn,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });

    coord.onAllReady();
    coord.onAllReady();
    coord.onAllReady();
    assert.equal(calls.length, 1, 'onAllReady 只首次触发');
  });

  it('start 注册的兜底定时器到期触发一次全量（经 onAllReady 守卫）', () => {
    const timers = makeFakeTimers();
    const { syncFn, calls } = makeSyncFn();
    const coord = createOfflineSyncCoordinator({}, {}, {
      windowMs: 500, fallbackMs: 30000, syncFn,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    coord.start();
    assert.equal(timers.pendingCount(), 1, 'start 应注册兜底定时器');
    timers.fire(30000);
    assert.equal(calls.length, 1, '兜底到期触发 1 次');
    timers.fire(30000); // 兜底不应再次触发（已被 onAllReady 守卫消耗）
    assert.equal(calls.length, 1);
  });

  it('stop 清理所有定时器，不再触发同步', () => {
    const timers = makeFakeTimers();
    const { syncFn, calls } = makeSyncFn();
    const coord = createOfflineSyncCoordinator({}, {}, {
      windowMs: 500, fallbackMs: 30000, syncFn,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    coord.start();
    coord.onAgentConnected('a1');
    assert.ok(timers.pendingCount() >= 1);
    coord.stop();
    assert.equal(timers.pendingCount(), 0, 'stop 后无残留定时器');
    timers.fireAll();
    assert.equal(calls.length, 0, 'stop 后不再同步');
  });

  it('messageHandler 为空时 onAgentConnected 不注册定时器（防御）', () => {
    const timers = makeFakeTimers();
    const { syncFn, calls } = makeSyncFn();
    const coord = createOfflineSyncCoordinator({}, null, {
      windowMs: 500, syncFn, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    coord.onAgentConnected('a1');
    assert.equal(timers.pendingCount(), 0);
    assert.equal(calls.length, 0);
  });

  it('syncFn 抛错被捕获，不外泄（coordinator 不应崩溃）', async () => {
    const timers = makeFakeTimers();
    const boom = async () => { throw new Error('sync boom'); };
    const coord = createOfflineSyncCoordinator({}, {}, {
      windowMs: 500, syncFn: boom, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    coord.onAgentConnected('a1');
    // 不应抛——内部 catch
    assert.doesNotThrow(() => timers.fire(500));
    // 给抛出的 promise 的 catch 一点时间
    await new Promise(r => setImmediate(r));
  });
});
