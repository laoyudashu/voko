const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// createLiteApp 已废弃（Desktop/Electron 路径停用），包装为返回明确错误的占位函数。
// 任何仍在调用的代码会收到结构化错误，而非静默失败。
describe('createLiteApp 占位（Desktop/Electron 已废弃）', () => {
  it('返回 success:false 与废弃说明，不抛异常', async () => {
    const { createLiteApp } = require('../build/index');
    const result = await createLiteApp({});
    assert.equal(result.success, false);
    assert.ok(result.error, '应返回错误说明');
    assert.match(result.error, /已废弃|deprecated/i);
  });

  it('无论传什么 options 都返回相同的废弃错误（不读 options、不碰 DB/网络）', async () => {
    const { createLiteApp } = require('../build/index');
    const r1 = await createLiteApp();
    const r2 = await createLiteApp({ dbPath: '/nonexistent/should/not/be/touched.db', foo: 'bar' });
    assert.equal(r1.success, false);
    assert.equal(r2.success, false);
    assert.equal(r1.error, r2.error, '错误文案应一致');
  });
});
