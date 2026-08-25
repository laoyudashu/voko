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

test('conversation live updates seed deduplication with server-rendered message ids', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /const renderedMessageIds=Object\.fromEntries\(msgs\.map\(m=>String\(m\.messageId\|\|m\.id\|\|''\)\)/);
  assert.match(web, /,_seen='\+jsonForInlineScript\(renderedMessageIds\)\+';'/);
  assert.doesNotMatch(web, /,_seen=\{\};/);
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

test('registered invitees are opened as an email search with conversation actions', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /r\.result==='already_registered'/);
  assert.match(web, /\/capabilities\?agentId='\+encodeURIComponent\([^)]+\)\+'\&q='\+encodeURIComponent\(email\)/);
  assert.match(web, /const sendHref='\/send-message\?agentId='/);
  assert.doesNotMatch(web, /conversationCount>0\?'\s*<span class="meta">\('/);
});

test('Agent discovery hides raw auth failures and free-form IM sends require directory validation', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /r\.code==='SEARCH_AUTH_REQUIRED'\?T\('web\.capabilities\.err_auth_required'\)/);
  assert.match(web, /name="validateRecipientUid" value="1"/);
  assert.match(web, /\/api\/im-users\/[^"']+\/exists/);
  assert.match(web, /validateRecipientUid==='1'/);
  assert.match(web, /RECIPIENT_NOT_FOUND/);
  assert.match(web, /isAgent:result\.isAgent===true,isOnline/);
  assert.match(web, /j\.isOnline===true\?"online":j\.isOnline===false\?"offline":"unknown"/);
  assert.match(web, /web\.send_message\.agent_offline/);
});

test('invitation forms require a custom dialog confirmation before submission', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /function inviteConfirmUi\(/);
  assert.match(web, /id="dlg-invite-confirm"/);
  assert.match(web, /e\.stopImmediatePropagation\(\)/);
  assert.match(web, /f\.requestSubmit\(\)/);
});

test('favicon is returned directly without sendFile path resolution', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/index.js'), 'utf8');
  assert.match(web, /res\.type\('image\/png'\)\.send\(require\('fs'\)\.readFileSync\(ico\)\)/);
  assert.doesNotMatch(web, /res\.type\('image\/png'\)\.sendFile\(ico\)/);
});
