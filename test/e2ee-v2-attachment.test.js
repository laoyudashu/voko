const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { decryptE2eeV2Attachment, parseE2eeV2Attachment } = require('../build/e2ee/v2-attachment');

const FORMAT = 'voko.e2ee.attachment/2';

function encrypt(bytes, messageId, chunkSize) {
  const key = crypto.randomBytes(32);
  const prefix = crypto.randomBytes(8);
  const chunkCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const chunks = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const iv = Buffer.alloc(12);
    prefix.copy(iv);
    iv.writeUInt32BE(index, 8);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${FORMAT}\0${messageId}\0${index}\0${chunkCount}`));
    const part = bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize));
    chunks.push(cipher.update(part), cipher.final(), cipher.getAuthTag());
  }
  return {
    ciphertext: Buffer.concat(chunks),
    manifest: {
      format: FORMAT,
      messageId,
      uploadId: 'upload_12345678',
      url: '/api/uploads/upload_12345678/download',
      cek: key.toString('base64url'),
      noncePrefix: prefix.toString('base64url'),
      chunkSize,
      chunkCount,
      plaintextSize: bytes.length,
      plaintextSha256: crypto.createHash('sha256').update(bytes).digest('base64url'),
      kind: 'file',
      fileName: 'sample.bin',
      mediaType: 'application/octet-stream'
    }
  };
}

test('Lite decrypts authenticated chunked E2EE v2 attachments', () => {
  const bytes = Buffer.alloc(180_000);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const vector = encrypt(bytes, 'e2ee-00000000-0000-4000-8000-000000000001', 64 * 1024);
  const manifest = parseE2eeV2Attachment(JSON.stringify(vector.manifest));
  assert.deepEqual(decryptE2eeV2Attachment(vector.ciphertext, manifest), bytes);

  const tampered = Buffer.from(vector.ciphertext);
  tampered[Math.floor(tampered.length / 2)] ^= 1;
  assert.throws(() => decryptE2eeV2Attachment(tampered, manifest));
});

test('Lite rejects malformed E2EE v2 attachment manifests', () => {
  const vector = encrypt(Buffer.from('content'), 'e2ee-00000000-0000-4000-8000-000000000002', 64 * 1024);
  assert.throws(() => parseE2eeV2Attachment(JSON.stringify({ ...vector.manifest, cek: 'invalid' })));
  assert.equal(parseE2eeV2Attachment(JSON.stringify({ ...vector.manifest, fileName: '../escape' })).fileName, 'escape');
});
