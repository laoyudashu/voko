'use strict';

const { createCipheriv, createDecipheriv } = require('node:crypto');

class CryptoContext {
  constructor() {
    this.aesKey = null;
    this.aesIV = null;
  }

  configure(aesKey, aesIV) {
    this.aesKey = aesKey;
    this.aesIV = aesIV;
  }

  _settings() {
    if (!this.aesKey || !this.aesIV) throw new Error('Encryption context is not configured');
    const key = Buffer.from(this.aesKey, 'utf8');
    return {
      algorithm: `aes-${key.length * 8}-cbc`,
      key,
      iv: Buffer.from(this.aesIV, 'utf8'),
    };
  }

  encryptString(value) {
    const { algorithm, key, iv } = this._settings();
    const cipher = createCipheriv(algorithm, key, iv);
    // Node's default padding is PKCS7, matching the IM wire format.
    return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
  }

  encryptBytes(value) {
    return this.encryptString(Buffer.from(value).toString('utf8'));
  }

  decryptBytes(value) {
    const ciphertext = Buffer.from(value).toString('latin1');
    const { algorithm, key, iv } = this._settings();
    const decipher = createDecipheriv(algorithm, key, iv);
    const clear = Buffer.concat([decipher.update(ciphertext, 'base64'), decipher.final()]);
    // Preserve the SDK's text payload contract and reject malformed UTF-8.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(clear);
    return Uint8Array.from(Buffer.from(text, 'utf8'));
  }
}

module.exports = { CryptoContext };
