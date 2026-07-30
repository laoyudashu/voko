const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('payment notifications use locale keys instead of mixed hard-coded labels', () => {
  const payment = fs.readFileSync(path.join(root, 'src/core/payment.ts'), 'utf8');
  assert.match(payment, /errors\.payment\.agent_notification/);
  assert.match(payment, /errors\.payment\.owner_notification/);
  assert.doesNotMatch(payment, /const payMsg2 = `\[Payment Notification\]\\n访客/);
  assert.doesNotMatch(payment, /const ownerMsg = '💰 支付成功通知/);
});

test('conversation rendering uses the peer Agent name for SSR and live messages', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /SELECT agent_name FROM agents WHERE imUid=\?/);
  assert.match(web, /const peerLabel=peerAgentName\|\|L\('web\.conversation\.from\.visitor'\)/);
  assert.match(web, /visitor:peerLabel/);
  assert.match(web, /m\.isMe===true\|\|m\.isMe===1/);
});

test('invitation email delivery failures render as a warning instead of success', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /r\.result==='email_failed'/);
  assert.match(web, /isWarning\?'pending':'success'/);
});

test('Agent detail actions link to the Agent-specific invitation page', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /href="\/agents\/'\+aId\+'\/invite"[^>]*>\s*'\+L\('web\.agent\.invite\.title'\)/);
});
