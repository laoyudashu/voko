'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CryptoContext } = require('../src/im-sdk/crypto-context');

// Captured from CryptoJS 4.2.0 before replacing it; these are wire-format fixtures.
const vectors = [
  ['', 'YZbS8taa29kYkI5N6lDDlA=='],
  ['中文🙂\u0000\n', 'kd6yigumOXyJfdB8PiVvsQ=='],
  ['1234567890123456', '8O0uFGaYj2NCcv+QlIFWJSygLpQbnf8KKpyPb2DdQIE='],
  ['12345678901234567', '8O0uFGaYj2NCcv+QlIFWJVbdyth7QdaxRcG/QXp8OjI='],
];

test('IM encryption and decryption preserve CryptoJS wire fixtures', () => {
  const context = new CryptoContext();
  context.configure('0123456789abcdef', 'abcdef0123456789');
  for (const [text, ciphertext] of vectors) {
    assert.equal(context.encryptString(text), ciphertext);
    assert.equal(context.encryptBytes(Buffer.from(text)), ciphertext);
    assert.deepEqual(context.decryptBytes(Buffer.from(ciphertext)), Uint8Array.from(Buffer.from(text)));
  }
});

test('IM crypto rejects missing configuration and truncated ciphertext', () => {
  const context = new CryptoContext();
  assert.throws(() => context.encryptString('hello'), /not configured/);
  assert.throws(() => context.decryptBytes(Buffer.from(vectors[0][1])), /not configured/);
  context.configure('0123456789abcdef', 'abcdef0123456789');
  const truncated = Buffer.from(vectors[0][1], 'base64').subarray(0, 15).toString('base64');
  assert.throws(() => context.decryptBytes(Buffer.from(truncated)));
});
