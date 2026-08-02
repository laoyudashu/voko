'use strict';

const CryptoJS = require('crypto-js');

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
    return {
      keySize: 128 / 8,
      iv: CryptoJS.enc.Utf8.parse(this.aesIV),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    };
  }

  encryptString(value) {
    return CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(value), CryptoJS.enc.Utf8.parse(this.aesKey), this._settings()).toString();
  }

  encryptBytes(value) {
    return this.encryptString(Buffer.from(value).toString('utf8'));
  }

  decryptBytes(value) {
    const ciphertext = Buffer.from(value).toString('latin1');
    const base64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Base64.parse(ciphertext));
    const clear = CryptoJS.AES.decrypt(base64, CryptoJS.enc.Utf8.parse(this.aesKey), this._settings());
    return Uint8Array.from(Buffer.from(clear.toString(CryptoJS.enc.Utf8), 'utf8'));
  }
}

module.exports = { CryptoContext };
