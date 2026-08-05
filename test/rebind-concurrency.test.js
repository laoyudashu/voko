const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// 测试 attachRebindAgentRuntime 内的串行化 wrapper 模式：
//   - 同 agent 的 rebind 串行排队（第二次等第一次完成才开始）
//   - 不同 agent 并行（互不阻塞）
//   - 失败的 rebind 不卡住同 agent 后续 rebind
// 这里直接复刻 wrapper 逻辑（与 src/index.ts attachRebindAgentRuntime 一致），
// 用 mock rebindImpl（返回可控延迟的 promise）验证时序。

function makeSerializedRebind(rebindImpl) {
  const rebindLocks = new Map();
  return async (input) => {
    const prev = rebindLocks.get(input.agentId) || Promise.resolve();
    const next = prev.then(() => rebindImpl(input));
    rebindLocks.set(input.agentId, next.catch(() => undefined));
    return next;
  };
}

describe('rebind 串行化包装', () => {
  it('同一 agent 连续两次 rebind 串行执行（第二次在第一次完成后才开始）', async () => {
    const order = [];
    const rebindImpl = async (input) => {
      order.push(`start-${input.tag}`);
      await new Promise(r => setTimeout(r, 30));
      order.push(`end-${input.tag}`);
      return { success: true, agentId: input.agentId };
    };
    const serialized = makeSerializedRebind(rebindImpl);

    const [r1, r2] = await Promise.all([
      serialized({ agentId: 'a1', tag: 'first' }),
      serialized({ agentId: 'a1', tag: 'second' }),
    ]);

    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    // 串行：first 完全结束在 second 开始之前
    assert.deepEqual(order, ['start-first', 'end-first', 'start-second', 'end-second']);
  });

  it('不同 agent 的 rebind 并行执行（互不阻塞）', async () => {
    let active = 0;
    let maxActive = 0;
    const rebindImpl = async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 30));
      active -= 1;
      return { success: true };
    };
    const serialized = makeSerializedRebind(rebindImpl);

    await Promise.all([
      serialized({ agentId: 'a1' }),
      serialized({ agentId: 'a2' }),
      serialized({ agentId: 'a3' }),
    ]);

    assert.ok(maxActive >= 2, `不同 agent 应并行，maxActive=${maxActive}`);
  });

  it('失败的 rebind 不卡住同 agent 后续 rebind', async () => {
    let callCount = 0;
    const rebindImpl = async (input) => {
      callCount += 1;
      if (callCount === 1) throw new Error('first fails');
      return { success: true };
    };
    const serialized = makeSerializedRebind(rebindImpl);

    // 第一次失败（被 wrapper 内 .catch 吞掉，不污染 rebindLocks）
    await serialized({ agentId: 'a1' }).catch(() => {});
    // 第二次仍能正常执行
    const r2 = await serialized({ agentId: 'a1' });
    assert.equal(r2.success, true);
    assert.equal(callCount, 2);
  });

  it('失败的 rebind 调用方仍能拿到 reject（wrapper 不吞调用方的错误）', async () => {
    const rebindImpl = async () => { throw new Error('boom'); };
    const serialized = makeSerializedRebind(rebindImpl);
    await assert.rejects(() => serialized({ agentId: 'a1' }), /boom/);
  });
});
