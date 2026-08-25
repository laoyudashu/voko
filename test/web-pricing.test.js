const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { createWebRouter } = require('../build/web');

async function startPricingApp(t, { hasPayment = true, durationMinutes = 10 } = {}) {
  const writes = [];
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'paid-agent', agentName: 'Paid Agent' }] }),
    get_agent_profile: async () => ({ success: true, data: { agentId: 'paid-agent', agentName: 'Paid Agent' } }),
    agent_pricing: async (params) => {
      if (Object.keys(params).length > 1) writes.push(params);
      return { pricingModel: 'duration', price: 0.01, durationMinutes, trialMinutes: 0 };
    },
    bind_agent_payment_auth: async () => ({ success: true }),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const db = { prepare: (sql) => ({
    get: () => {
      if (sql.includes('JOIN payment_auth')) return hasPayment ? { name: '张三', bank_name: '测试银行', bank_card: '6222000012345678' } : null;
      if (sql.includes("type='current_user_email'")) return { data: JSON.stringify('owner@example.com') };
      if (sql.includes('FROM agents WHERE agent_id=')) return { agent_id: 'paid-agent', agent_name: 'Paid Agent', payment_auth_id: 'card-1', payment_fee_rate: 0.012, agent_usage_fee_rate: 0.15 };
      return null;
    },
    all: () => sql.includes('FROM payment_auth WHERE')
      ? [{ id: 'card-1', name: '张三', bank_name: '测试银行', bank_card: '6222000012345678' }]
      : [],
  }) };
  app.use(createWebRouter(handlers, db));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { base: `http://127.0.0.1:${server.address().port}`, writes };
}

test('pricing page renders the stored free-trial duration including zero', async (t) => {
  const { base } = await startPricingApp(t);
  const response = await fetch(`${base}/agents/paid-agent/pricing`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="pt" name="trialMinutes" type="number" min="0" step="1" required value="0"/);
  assert.match(html, /免费体验时长（分钟，0 表示不提供）/);
  assert.match(html, /class="pricing-trial"/);
  assert.match(html, /input\.disabled=!paid\|\|blocked/);
  assert.match(html, /已绑定收款银行卡：<strong>张\* · 测试银行 •••• 5678<\/strong>/);
  assert.match(html, />重新绑定<\/a>/);
  assert.match(html, /class="pricing-model-row"><select id="pm"[\s\S]*?<span id="pricing-payment-bound">/);
  assert.doesNotMatch(html, /6222000012345678/);
});

test('pricing page presents an exact week without requiring minute calculation', async (t) => {
  const { base } = await startPricingApp(t, { durationMinutes: 10080 });
  const response = await fetch(`${base}/agents/paid-agent/pricing`);
  const html = await response.text();
  assert.match(html, /<option value="week" selected>周<\/option>/);
  assert.match(html, /id="pd" type="number" min="1" step="1" required value="1"><select id="pricing-duration-unit"/);
  assert.match(html, /id="pricing-duration-total"/);
  assert.match(html, /（共 \{minutes\} 分钟）/);
  assert.match(html, /unit\.addEventListener\("change",updateMinutes\)/);
  assert.match(html, /multipliers=\{minute:1,hour:60,day:1440,week:10080,month:43200\}/);
});

test('pricing form and JSON action preserve a zero free-trial duration', async (t) => {
  const { base, writes } = await startPricingApp(t);
  const formResponse = await fetch(`${base}/agents/paid-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '_action=set_pricing&pricingModel=duration&price=0.01&durationMinutes=10&trialMinutes=0',
    redirect: 'manual',
  });
  assert.equal(formResponse.status, 302);
  assert.equal(writes[0].trialMinutes, 0);

  const apiResponse = await fetch(`${base}/api/agents/paid-agent/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _action: 'set_pricing', pricingModel: 'duration', price: 0.01, durationMinutes: 10, trialMinutes: 0 }),
  });
  assert.equal(apiResponse.status, 200);
  assert.equal(writes[1].trialMinutes, 0);
});

test('pricing page blocks paid mode until a verified receiving card is configured', async (t) => {
  const { base, writes } = await startPricingApp(t, { hasPayment: false });
  const page = await fetch(`${base}/agents/paid-agent/pricing`);
  const html = await page.text();
  assert.match(html, /尚未配置已认证的收款银行卡，付费模式不可用。/);
  assert.match(html, /href="\/agents\/paid-agent\/payment-auth\?returnTo=[^"]+">去配置支付<\/a>/);
  assert.match(html, /warning\.hidden=!blocked/);
  assert.match(html, /submit\.disabled=blocked/);
  assert.doesNotMatch(html, /option\[value=duration\]"\)\.disabled=true/);

  const response = await fetch(`${base}/agents/paid-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '_action=set_pricing&pricingModel=duration&price=0.01&durationMinutes=10&trialMinutes=0',
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.match(response.headers.get('location'), /\/agents\/paid-agent\/pricing\?err=/);
});

test('pricing API rejects invalid numeric paid settings', async (t) => {
  const { base, writes } = await startPricingApp(t);
  const response = await fetch(`${base}/api/agents/paid-agent/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _action: 'set_pricing', pricingModel: 'duration', price: 0.01, durationMinutes: 1.5, trialMinutes: -1 }),
  });
  const result = await response.json();
  assert.equal(result.success, false);
  assert.match(result.error, /请输入有效的价格/);
  assert.equal(writes.length, 0);
});

test('receiving-card selector includes the bank-card owner name', async (t) => {
  const { base } = await startPricingApp(t);
  const response = await fetch(`${base}/agents/paid-agent/payment-auth`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /张三 · 测试银行 •••• 5678/);
  assert.match(html, /服务费说明/);
  assert.match(html, /支付手续费：1\.2%/);
  assert.match(html, /收取 1\.2 元手续费，您实际到账 98\.8 元/);
  assert.match(html, /订阅手续费：15%/);
  assert.match(html, /收取 15 元手续费，您实际到账 85 元/);
  assert.match(html, /结算周期说明/);
  assert.match(html, /第二个工作日统一到账。如遇周末和节假日，顺延至下一个工作日。/);
});

test('successful card binding returns to pricing with paid mode selected', async (t) => {
  const { base } = await startPricingApp(t);
  const returnTo = '/agents/paid-agent/pricing?mode=duration';
  const page = await fetch(`${base}/agents/paid-agent/payment-auth?returnTo=${encodeURIComponent(returnTo)}`);
  const html = await page.text();
  assert.match(html, /name="returnTo" value="\/agents\/paid-agent\/pricing\?mode=duration"/);

  const response = await fetch(`${base}/agents/paid-agent/payment-auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `paymentAuthId=card-1&returnTo=${encodeURIComponent(returnTo)}`,
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), returnTo);
});
