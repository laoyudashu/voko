const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendProviderAttachmentBoundary, buildAcpAttachmentPrompt, stageProviderAttachments,
  cleanupExpiredProviderAttachmentStaging } = require('../build/core/dispatcher/provider-attachments');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-provider-attachment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'neutral.png');
  const bytes = Buffer.from('verified-image-bytes');
  fs.writeFileSync(filePath, bytes);
  return { bytes, attachment: { path: filePath, name: 'neutral.png', mediaType: 'image/png', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
}

test('provider attachment boundary hands a verified absolute local path to text-only providers', (t) => {
  const { attachment } = fixture(t);
  const text = appendProviderAttachmentBoundary('inspect this file', { attachments: [attachment] });
  assert.match(text, /Voko attachment boundary/);
  assert.match(text, new RegExp(attachment.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, new RegExp(attachment.sha256));
});

test('ACP prompt hands verified image bytes to the agent without requiring successful recognition', (t) => {
  const { bytes, attachment } = fixture(t);
  const prompt = buildAcpAttachmentPrompt('inspect this file', { attachments: [attachment] });
  assert.deepEqual(prompt, [
    { type: 'text', text: 'inspect this file' },
    { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
  ]);
});

test('ACP prompt hands non-image files and unsupported images to the agent as baseline resource links', (t) => {
  const { attachment } = fixture(t);
  const prompt = buildAcpAttachmentPrompt('inspect this file', { attachments: [{ ...attachment,
    name: 'report.pdf', mediaType: 'application/pdf' }] }, { imageSupported: false });
  assert.equal(prompt[1].type, 'resource_link');
  assert.equal(prompt[1].name, 'report.pdf');
  assert.equal(prompt[1].mimeType, 'application/pdf');
  assert.equal(prompt[1].size, attachment.size);
  assert.match(prompt[1].uri, /^file:\/\//);
});

test('ACP embeds verified text and binary resources when the agent advertises embedded context', (t) => {
  const { bytes, attachment } = fixture(t);
  const textPrompt = buildAcpAttachmentPrompt('inspect', { attachments: [{ ...attachment,
    name: 'report.md', mediaType: 'text/markdown' }] }, { embeddedContextSupported: true, imageSupported: false });
  assert.deepEqual(textPrompt[1], { type: 'resource', resource: {
    uri: 'voko-attachment:///report.md', mimeType: 'text/markdown', text: bytes.toString('utf8'),
  } });
  const binaryPrompt = buildAcpAttachmentPrompt('inspect', { attachments: [{ ...attachment,
    name: 'report.pdf', mediaType: 'application/pdf' }] }, { embeddedContextSupported: true, imageSupported: false });
  assert.deepEqual(binaryPrompt[1], { type: 'resource', resource: {
    uri: 'voko-attachment:///report.pdf', mimeType: 'application/pdf', blob: bytes.toString('base64'),
  } });
  const recoveredPrompt = buildAcpAttachmentPrompt('inspect', { attachments: [{ ...attachment,
    name: 'opaque-upload.md', mediaType: 'application/octet-stream' }] },
  { embeddedContextSupported: true, imageSupported: false });
  assert.equal(recoveredPrompt[1].resource.mimeType, 'text/markdown');
  assert.equal(recoveredPrompt[1].resource.text, bytes.toString('utf8'));
});

test('path-only providers receive isolated safe staged names and cleanup removes the turn directory', (t) => {
  const { attachment } = fixture(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-stage-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const staged = stageProviderAttachments({ attachments: [{ ...attachment, name: '..\\CON?.md' }] },
    { cwd, agentId: 'agent-1', turnId: 'turn-1' });
  assert.equal(staged.attachments.length, 1);
  assert.equal(path.dirname(staged.attachments[0].path), staged.directory);
  assert.doesNotMatch(path.basename(staged.attachments[0].path), /[?\\/]/);
  assert.equal(fs.readFileSync(staged.attachments[0].path, 'utf8'), fs.readFileSync(attachment.path, 'utf8'));
  staged.cleanup();
  assert.equal(fs.existsSync(staged.directory), false);
  cleanupExpiredProviderAttachmentStaging(path.join(cwd, 'missing'));
});

test('ACP file delivery preserves every upload-supported non-native-image media type', (t) => {
  const { attachment } = fixture(t);
  for (const mediaType of ['image/bmp', 'video/mp4', 'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'audio/mpeg',
    'text/plain', 'application/json', 'application/octet-stream']) {
    const prompt = buildAcpAttachmentPrompt('inspect', { attachments: [{ ...attachment, name: 'neutral.bin', mediaType }] });
    assert.equal(prompt[1].type, 'resource_link', mediaType);
    assert.equal(prompt[1].mimeType, mediaType);
  }
});

test('provider attachment delivery fails closed when the decrypted file changes', (t) => {
  const { attachment } = fixture(t);
  fs.appendFileSync(attachment.path, '!');
  assert.throws(() => appendProviderAttachmentBoundary('inspect', { attachments: [attachment] }), /does not match/);
});
