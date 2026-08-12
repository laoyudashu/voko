const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OwnerGatewayKeyStore, initOwnerLinkDatabase } = require('../build/owner-link');

function encoded(publicKey) { return publicKey.export({ format: 'der', type: 'spki' }).toString('base64'); }

test('Owner gateway key store accepts one active and one previous Ed25519 key', () => {
  const db = initOwnerLinkDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-keys-')), 'owner.db'));
  try {
    const active = crypto.generateKeyPairSync('ed25519');
    const previous = crypto.generateKeyPairSync('ed25519');
    const store = new OwnerGatewayKeyStore(db);
    assert.equal(store.configure([
      { keyId: 'key-active', algorithm: 'Ed25519', publicKeySpkiBase64: encoded(active.publicKey), status: 'active' },
      { keyId: 'key-previous', algorithm: 'Ed25519', publicKeySpkiBase64: encoded(previous.publicKey), status: 'previous' },
    ]), 2);
    assert.equal(store.resolve('key-active').asymmetricKeyType, 'ed25519');
    assert.equal(new OwnerGatewayKeyStore(db).count(), 2);
  } finally { db.close(); }
});

test('Owner gateway key store rejects invalid algorithms and ambiguous active keys', () => {
  const db = initOwnerLinkDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-keys-invalid-')), 'owner.db'));
  try {
    const key = crypto.generateKeyPairSync('ed25519');
    const store = new OwnerGatewayKeyStore(db);
    assert.throws(() => store.configure([{ keyId: 'key', algorithm: 'RSA', publicKeySpkiBase64: encoded(key.publicKey), status: 'active' }]), /OWNER_KEY_CONFIG_INVALID/);
    assert.throws(() => store.configure([
      { keyId: 'one', algorithm: 'Ed25519', publicKeySpkiBase64: encoded(key.publicKey), status: 'active' },
      { keyId: 'two', algorithm: 'Ed25519', publicKeySpkiBase64: encoded(key.publicKey), status: 'active' },
    ]), /OWNER_KEY_CONFIG_INVALID/);
  } finally { db.close(); }
});
