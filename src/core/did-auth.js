/**
 * DID 认证通用工具
 *
 * 提供 Ed25519 私钥提取和 DID 请求签名，供主进程 IPC、MCP 工具等共享。
 */

const { signAsync } = require('@noble/ed25519');

// 将 PEM / base64 / hex 格式 Ed25519 私钥解析为 raw 32 字节
function extractEd25519PrivateKey(pem) {
  const cleaned = pem
    .replace(/-----BEGIN [\w\s]+ KEY-----/g, '')
    .replace(/-----END [\w\s]+ KEY-----/g, '')
    .replace(/\s/g, '');
  const bytes = Buffer.from(cleaned, 'base64');

  // 如果刚好 32 字节，直接使用
  if (bytes.length === 32) return new Uint8Array(bytes);

  // 如果末尾有 32 字节（PKCS#8 DER），取末尾 32 字节
  if (bytes.length > 32) {
    const slice = bytes.slice(-32);
    if (slice.length === 32) return new Uint8Array(slice);
  }

  // 兜底：尝试 hex 解码
  if (cleaned.length === 64 && /^[0-9a-f]+$/i.test(cleaned)) {
    return new Uint8Array(Buffer.from(cleaned, 'hex'));
  }

  console.warn('[extractEd25519PrivateKey] unexpected key length:', bytes.length, 'trying first 32 bytes');
  return new Uint8Array(bytes.slice(0, 32));
}

/**
 * DID 请求签名工具函数
 * @param {string} did - Agent DID（did:wba:...）
 * @param {string} privateKey - PEM 格式 Ed25519 私钥
 * @param {object} businessFields - 除 did/nonce/timestamp/signature 外的业务字段
 * @returns {object} { did, nonce, timestamp, signature }
 */
async function signDidRequest(did, privateKey, businessFields) {
  const nonce = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const timestamp = Math.floor(Date.now() / 1000);
  const sortedKeys = Object.keys(businessFields).sort();
  const bodyPayload = JSON.stringify(businessFields, sortedKeys);
  const toSign = did + '\n' + nonce + '\n' + timestamp + '\n' + bodyPayload;
  const rawKey = extractEd25519PrivateKey(privateKey);
  const sigBytes = await signAsync(new TextEncoder().encode(toSign), rawKey);
  const signature = Buffer.from(sigBytes).toString('base64');
  return { did, nonce, timestamp, signature };
}

module.exports = { extractEd25519PrivateKey, signDidRequest };
