const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert');
const { createToolHandlers } = require('../build/mcp/tools');
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeCx() {
  const paymentAuthRows = [];
  const bankRows = [
    { code: 'ICBC', name: '中国工商银行', short_name: '工商银行' },
    { code: 'ABC', name: '中国农业银行', short_name: '农业银行' },
  ];
  const agentRows = [
    { agent_id: 'a1', owner_email: 'owner@example.com', did: 'did:wba:a1', private_key: 'pk1', payment_auth_id: null, payment_fee_rate: null, agent_usage_fee_rate: null },
  ];

  return {
    db: {},
    query: (sql, params) => {
      if (/FROM payment_auth/i.test(sql)) {
        if (/WHERE id = ?/i.test(sql)) {
          return paymentAuthRows.filter((r) => r.id === params[0]);
        }
        if (/WHERE payment_auth_id = ? AND agent_id != ?/i.test(sql)) {
          return paymentAuthRows
            .filter((r) => r.payment_auth_id === params[0] && r.agent_id !== params[1])
            .map((r) => ({ payment_fee_rate: r.payment_fee_rate, agent_usage_fee_rate: r.agent_usage_fee_rate }));
        }
        if (/WHERE name LIKE \? OR bank_card LIKE \? OR phone LIKE \?/i.test(sql)) {
          const kw = params[0].replace(/%/g, '');
          return paymentAuthRows
            .filter((r) => r.name.includes(kw) || r.bank_card.includes(kw) || r.phone.includes(kw))
            .map((r) => ({ ...r }));
        }
        return paymentAuthRows.map((r) => ({ ...r }));
      }
      if (/FROM bank_head_offices/i.test(sql)) {
        if (!params || params.length === 0) return bankRows;
        const kw = params[0].replace(/%/g, '').toLowerCase();
        return bankRows.filter(
          (r) =>
            r.code.toLowerCase().includes(kw) ||
            r.name.toLowerCase().includes(kw) ||
            r.short_name.toLowerCase().includes(kw)
        );
      }
      if (/FROM agents/i.test(sql)) {
        if (/WHERE agent_id = \?/i.test(sql)) {
          return agentRows.filter((r) => r.agent_id === params[0]).map((r) => ({ ...r }));
        }
        if (/WHERE payment_auth_id = \? AND agent_id != \?/i.test(sql)) {
          return agentRows
            .filter((r) => r.payment_auth_id === params[0] && r.agent_id !== params[1])
            .map((r) => ({ payment_fee_rate: r.payment_fee_rate, agent_usage_fee_rate: r.agent_usage_fee_rate }));
        }
        if (/WHERE payment_auth_id = \? AND owner_email IS NOT NULL LIMIT 1/i.test(sql)) {
          const matched = agentRows.filter((r) => r.payment_auth_id === params[0] && r.owner_email);
          return matched.length ? [{ owner_email: matched[0].owner_email }] : [];
        }
        if (/WHERE owner_email IS NOT NULL LIMIT 1/i.test(sql)) {
          const matched = agentRows.filter((r) => r.owner_email);
          return matched.length ? [{ owner_email: matched[0].owner_email }] : [];
        }
        if (/SELECT DISTINCT owner_email FROM agents WHERE owner_email IS NOT NULL LIMIT 2/i.test(sql)) {
          return [...new Set(agentRows.map((r) => r.owner_email).filter(Boolean))].slice(0, 2).map((owner_email) => ({ owner_email }));
        }
        return [];
      }
      return [];
    },
    exec: (sql, params) => {
      if (/INSERT INTO payment_auth/i.test(sql)) {
        const [
          id, name, id_card, bank_card, phone, receiver_type, bank_code, bank_name,
          company_name, unified_social_credit_code, legal_name, legal_licence_no, status, created_at, updated_at,
        ] = params;
        paymentAuthRows.push({
          id, name, id_card, bank_card, phone, receiver_type, bank_code, bank_name,
          company_name, unified_social_credit_code, legal_name, legal_licence_no,
          status, created_at, updated_at, receiver_apply_status: 'none',
        });
        return { changes: 1 };
      }
      if (/UPDATE payment_auth/i.test(sql)) {
        const id = params[params.length - 1];
        const idx = paymentAuthRows.findIndex((r) => r.id === id);
        if (idx >= 0) {
          // apply_payment_auth 更新字段
          if (/request_no/.test(sql)) {
            const [
              request_no, receiver_no, receiver_apply_status, receiver_sign_status,
              receiver_sign_url, merchant_sign_url, payment_user_uid, status, updated_at,
            ] = params;
            paymentAuthRows[idx].request_no = request_no;
            paymentAuthRows[idx].receiver_no = receiver_no;
            paymentAuthRows[idx].receiver_apply_status = receiver_apply_status;
            paymentAuthRows[idx].receiver_sign_status = receiver_sign_status;
            paymentAuthRows[idx].receiver_sign_url = receiver_sign_url;
            paymentAuthRows[idx].merchant_sign_url = merchant_sign_url;
            paymentAuthRows[idx].payment_user_uid = payment_user_uid;
            paymentAuthRows[idx].status = status;
            paymentAuthRows[idx].updated_at = updated_at;
          } else {
            // 简单更新：仅支持本测试需要的字段
            const fields = ['name', 'id_card', 'bank_card', 'phone', 'receiver_type', 'bank_code', 'bank_name', 'receiver_no', 'receiver_apply_status', 'receiver_sign_status', 'receiver_sign_url', 'merchant_sign_url', 'status', 'updated_at'];
            const setMatch = sql.match(/SET (.+?) WHERE/i);
            if (setMatch) {
              const sets = setMatch[1].split(',').map((s) => s.trim().split('=')[0].trim());
              sets.forEach((field, i) => {
                if (fields.includes(field)) paymentAuthRows[idx][field] = params[i];
              });
              paymentAuthRows[idx].updated_at = params[params.length - 2];
            }
          }
        }
        return { changes: 1 };
      }
      if (/UPDATE agents SET payment_auth_id = \? WHERE agent_id = \?/i.test(sql)) {
        const [paymentAuthId, agentId] = params;
        const idx = agentRows.findIndex((r) => r.agent_id === agentId);
        if (idx >= 0) agentRows[idx].payment_auth_id = paymentAuthId;
        return { changes: 1 };
      }
      if (/UPDATE agents SET payment_auth_id = NULL, updated_at = \? WHERE payment_auth_id = \?/i.test(sql)) {
        const [updatedAt, paymentAuthId] = params;
        agentRows.forEach((r) => { if (r.payment_auth_id === paymentAuthId) r.payment_auth_id = null; });
        return { changes: 1 };
      }
      if (/DELETE FROM payment_auth/i.test(sql)) {
        const [id] = params;
        for (let i = paymentAuthRows.length - 1; i >= 0; i--) {
          if (paymentAuthRows[i].id === id) paymentAuthRows.splice(i, 1);
        }
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    signDidRequest: async (did, privateKey, bizFields) => ({
      did,
      nonce: 'n1',
      timestamp: 1234567890,
      signature: 'sig1',
    }),
    getUserAccessToken: (email) => email === 'owner@example.com' ? 'ut_test_token' : null,
    VOKO_API_URL: 'http://test.voko.com',
    _paymentAuthRows: paymentAuthRows,
    _agentRows: agentRows,
  };
}

describe('MCP payment auth', () => {
  it('应存在 payment auth handlers', () => {
    const handlers = createToolHandlers({ db: {} });
    assert.equal(typeof handlers.add_payment_auth, 'function');
    assert.equal(typeof handlers.list_payment_auth, 'function');
    assert.equal(typeof handlers.delete_payment_auth, 'function');
    assert.equal(typeof handlers.apply_payment_auth, 'function');
    assert.equal(typeof handlers.refresh_payment_auth, 'function');
    assert.equal(typeof handlers.search_banks, 'function');
    assert.equal(typeof handlers.bind_agent_payment_auth, 'function');
  });

  it('add_payment_auth 应新增个人银行卡并返回 id', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    const r = await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    assert.equal(r.success, true);
    assert.ok(r.id);
    assert.equal(cx._paymentAuthRows.length, 1);
    assert.equal(cx._paymentAuthRows[0].bank_code, 'ICBC');
    assert.equal(cx._paymentAuthRows[0].receiver_type, 1);
  });

  it('add_payment_auth 缺少 bankCode 应失败', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    const r = await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
    });
    assert.equal(r.success, false);
    assert.match(r.error, /bankCode/);
  });

  it('list_payment_auth 应返回脱敏列表', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    const r = await handlers.list_payment_auth({});
    assert.equal(r.success, true);
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].nameMask, '张*');
    assert.equal(r.data[0].receiverTypeLabel, '对私');
  });

  it('list_payment_auth 应支持 keyword 过滤', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    await handlers.add_payment_auth({
      name: '李四',
      idCard: '110101199001015678',
      bankCard: '6222021234567895678',
      phone: '13900139000',
      bankCode: 'ABC',
      bankName: '中国农业银行',
    });
    const r = await handlers.list_payment_auth({ keyword: '张三' });
    assert.equal(r.success, true);
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].name, '张三');
  });

  it('search_banks 应按关键字搜索银行', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    const r = await handlers.search_banks({ keyword: '工商' });
    assert.equal(r.success, true);
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].code, 'ICBC');
  });

  it('bind_agent_payment_auth 未申请时应提示先申请', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    const paymentAuthId = cx._paymentAuthRows[0].id;

    const r = await handlers.bind_agent_payment_auth({ agentId: 'a1', paymentAuthId });
    assert.equal(r.success, false);
    assert.match(r.error, /尚未申请认证/);
  });

  it('bind_agent_payment_auth 已申请时应本地绑定银行卡', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    cx._paymentAuthRows[0].payment_user_uid = 'pu_xxx';
    cx._paymentAuthRows[0].receiver_apply_status = 'COMPLETED';
    const paymentAuthId = cx._paymentAuthRows[0].id;

    // 模拟服务端返回
    global.fetch = async () => ({
      json: async () => ({ code: 200, data: { paymentFeeRate: 0.006, agentUsageFeeRate: 0.1 } }),
    });

    const r = await handlers.bind_agent_payment_auth({ agentId: 'a1', paymentAuthId });
    assert.equal(r.success, true);
    assert.equal(cx._agentRows[0].payment_auth_id, paymentAuthId);

    delete global.fetch;
  });

  it('delete_payment_auth 应删除银行卡并解除 Agent 绑定', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    const paymentAuthId = cx._paymentAuthRows[0].id;
    cx._agentRows[0].payment_auth_id = paymentAuthId;

    const r = await handlers.delete_payment_auth({ id: paymentAuthId });
    assert.equal(r.success, true);
    assert.equal(cx._paymentAuthRows.length, 0);
    assert.equal(cx._agentRows[0].payment_auth_id, null);
  });

  it('apply_payment_auth 应向服务端申请认证', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    const paymentAuthId = cx._paymentAuthRows[0].id;

    global.fetch = async (url, options) => {
      assert.ok(url.includes('/payment/receiver/apply'));
      const body = JSON.parse(options.body);
      assert.equal(body.email, 'owner@example.com');
      assert.equal(body.licenceNo, '110101199001011234');
      return {
        json: async () => ({ code: 200, data: { paymentUserUid: 'pu_xxx', requestNo: 'REQ_xxx', receiverApplyStatus: 'COMPLETED' } }),
      };
    };

    const r = await handlers.apply_payment_auth({ paymentAuthId });
    assert.equal(r.success, true);
    assert.equal(cx._paymentAuthRows[0].payment_user_uid, 'pu_xxx');
    assert.equal(cx._paymentAuthRows[0].request_no, 'REQ_xxx');

    delete global.fetch;
  });

  it('apply_payment_auth 拒绝缺少身份字段的伪成功响应且不写本地状态', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    const paymentAuthId = cx._paymentAuthRows[0].id;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ code: 200, data: { receiverApplyStatus: 'PROCESSING' } }),
    });

    const result = await handlers.apply_payment_auth({ paymentAuthId });

    assert.equal(result.success, false);
    assert.equal(cx._paymentAuthRows[0].request_no, undefined);
    assert.equal(cx._paymentAuthRows[0].payment_user_uid, undefined);
  });

  it('refresh_payment_auth 应查询并持久化认证完成状态', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    const auth = cx._paymentAuthRows[0];
    auth.request_no = 'REQ_1';
    global.fetch = async (url, options) => {
      assert.match(url, /payment\/receiver\/query$/);
      assert.equal(JSON.parse(options.body).requestNo, 'REQ_1');
      return {
        ok: true,
        json: async () => ({ code: 200, data: { status: 'COMPLETED', receiverNo: 'R_1' } }),
      };
    };

    const result = await handlers.refresh_payment_auth({ paymentAuthId: auth.id });

    assert.equal(result.success, true);
    assert.equal(auth.receiver_apply_status, 'COMPLETED');
    assert.equal(auth.receiver_no, 'R_1');
    assert.equal(auth.status, 'verified');
  });

  it('apply_payment_auth 将非 JSON 上游响应归类为失败', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    global.fetch = async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    });

    const result = await handlers.apply_payment_auth({
      paymentAuthId: cx._paymentAuthRows[0].id,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Unexpected token/);
  });

  it('bind_agent_payment_auth 拒绝非法费率且不绑定 Agent', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    cx._paymentAuthRows[0].payment_user_uid = 'pu_xxx';
    cx._paymentAuthRows[0].receiver_apply_status = 'COMPLETED';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: { paymentFeeRate: '0.006', agentUsageFeeRate: -1 },
      }),
    });

    const result = await handlers.bind_agent_payment_auth({
      agentId: 'a1',
      paymentAuthId: cx._paymentAuthRows[0].id,
    });

    assert.equal(result.success, false);
    assert.equal(cx._agentRows[0].payment_auth_id, null);
  });

  it('bind_agent_payment_auth 在上游 HTTP 失败时不绑定 Agent', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    cx._paymentAuthRows[0].payment_user_uid = 'pu_xxx';
    cx._paymentAuthRows[0].receiver_apply_status = 'COMPLETED';
    global.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ code: 503, msg: '支付服务维护中' }),
    });

    const result = await handlers.bind_agent_payment_auth({
      agentId: 'a1',
      paymentAuthId: cx._paymentAuthRows[0].id,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, '支付服务维护中');
    assert.equal(cx._agentRows[0].payment_auth_id, null);
  });

  it('bind_agent_payment_auth 在上游非 JSON HTTP 失败时保留状态码', async () => {
    const cx = makeCx();
    const handlers = createToolHandlers(cx);
    await handlers.add_payment_auth({
      name: '张三',
      idCard: '110101199001011234',
      bankCard: '6222021234567891234',
      phone: '13800138000',
      bankCode: 'ICBC',
      bankName: '中国工商银行',
    });
    cx._paymentAuthRows[0].payment_user_uid = 'pu_xxx';
    cx._paymentAuthRows[0].receiver_apply_status = 'COMPLETED';
    global.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    });

    const result = await handlers.bind_agent_payment_auth({
      agentId: 'a1',
      paymentAuthId: cx._paymentAuthRows[0].id,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /HTTP 502/);
    assert.equal(cx._agentRows[0].payment_auth_id, null);
  });
});
