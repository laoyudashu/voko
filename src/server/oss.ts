export {};

/**
 * OSS 签名生成 - 用于前端直传文件到阿里云 OSS
 * 采用 PostObject 直传模式：后端签名，前端直传
 */
const crypto = require('crypto');
const ENDPOINTS = require('../endpoints.json');
const { assertSecureEndpoint } = require('../core/url-security');

// 默认配置（优先使用环境变量，其次 endpoints.json）
let OSS_REGION = process.env.OSS_REGION || ENDPOINTS.oss.region;
let OSS_BUCKET = process.env.OSS_BUCKET || ENDPOINTS.oss.bucket;
let OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
let OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';
let OSS_ENDPOINT = assertSecureEndpoint(process.env.OSS_ENDPOINT || ENDPOINTS.oss.endpoint, 'http');
let OSS_PUBLIC_URL = assertSecureEndpoint(
  process.env.VOKO_E2E_OSS_BASE_URL || process.env.OSS_PUBLIC_URL || ENDPOINTS.oss.publicUrl,
  'http',
);

/**
 * 从配置对象加载 OSS 配置（支持 DB / JSON 来源）
 */
function loadConfigFromObject(config?: any) {
  const ossConfig = config.oss_config;
  if (!ossConfig) return false;
  if (!OSS_ACCESS_KEY_ID && ossConfig.accessKeyId) OSS_ACCESS_KEY_ID = ossConfig.accessKeyId;
  if (!OSS_ACCESS_KEY_SECRET && ossConfig.accessKeySecret) OSS_ACCESS_KEY_SECRET = ossConfig.accessKeySecret;
  if (ossConfig.region) OSS_REGION = ossConfig.region;
  if (ossConfig.bucket) OSS_BUCKET = ossConfig.bucket;
  if (ossConfig.endpoint) OSS_ENDPOINT = assertSecureEndpoint(ossConfig.endpoint, 'http');
  if (ossConfig.publicUrl) OSS_PUBLIC_URL = assertSecureEndpoint(ossConfig.publicUrl, 'http');
  return true;
}

/**
 * 供 main.js 在 DB 初始化后调用，从 DB 配置加载 OSS 凭证
 */
function initOSSFromConfig(config?: any) {
  if (OSS_ACCESS_KEY_ID && OSS_ACCESS_KEY_SECRET) return; // 环境变量优先
  if (loadConfigFromObject(config)) {
  }
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) {
    console.warn('[OSS] AccessKey 未配置，OSS 签名接口将不可用');
  }
}

/**
 * 生成 OSS PostObject 直传签名
 * @param {string} objectName - OSS 中的 object key（如 chat/images/xxx.jpg）
 * @param {string} contentType - 文件 MIME 类型（可选）
 * @param {number} maxSize - 最大文件大小（字节），默认 100MB
 * @returns {Object} 签名参数，前端可直接用于 FormData POST 到 OSS
 */
function generateOSSSignature(objectName?: any, contentType: any = '', maxSize: any = 100 * 1024 * 1024) {
  const expiration = new Date(Date.now() + 3600 * 1000).toISOString();

  const conditions = [
    ['content-length-range', 0, maxSize],
    { bucket: OSS_BUCKET },
    ['eq', '$key', objectName]
  ];

  if (contentType) {
    conditions.push(['eq', '$Content-Type', contentType]);
  }

  const disposition = objectName.startsWith('chat/images/') ? 'inline' : 'attachment';
  conditions.push(['eq', '$Content-Disposition', disposition]);

  const policyObj = { expiration, conditions };
  const policy = Buffer.from(JSON.stringify(policyObj)).toString('base64');
  const signature = crypto
    .createHmac('sha1', OSS_ACCESS_KEY_SECRET)
    .update(policy)
    .digest('base64');

  return {
    endpoint: OSS_ENDPOINT,
    publicUrl: OSS_PUBLIC_URL,
    bucket: OSS_BUCKET,
    region: OSS_REGION,
    key: objectName,
    OSSAccessKeyId: OSS_ACCESS_KEY_ID,
    policy,
    Signature: signature,
    contentType,
    expiration
  };
}

/**
 * 服务端上传 base64 图片到 OSS
 * @param {string} base64DataUrl - data:image/xxx;base64,xxxxx
 * @param {string} objectName - OSS object key，如 chat/pay/qr_xxx.png
 * @returns {Promise<string>} 公开访问的图片 URL
 */
async function uploadBase64ToOSS(base64DataUrl?: any, objectName?: any, onProgress?: any) {
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) {
    throw new Error('OSS AccessKey 未配置');
  }

  const matches = base64DataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!matches) throw new Error('无效的 base64 data URL');
  const contentType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');

  // OSS REST API PUT 签名（含 x-oss-object-acl 头）
  const date = new Date().toUTCString();
  const ossHeaders = 'x-oss-object-acl:public-read';
  const resource = `/${OSS_BUCKET}/${objectName}`;
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossHeaders}\n${resource}`;
  const signature = crypto
    .createHmac('sha1', OSS_ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest('base64');

  const url = `${OSS_PUBLIC_URL}/${objectName}`;

  if (onProgress) onProgress(0);
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `OSS ${OSS_ACCESS_KEY_ID}:${signature}`,
      'Content-Type': contentType,
      'Date': date,
      'Content-Length': String(buffer.length),
      'x-oss-object-acl': 'public-read'
    },
    body: buffer
  });

  if (onProgress) onProgress(100);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OSS 上传失败 (${resp.status}): ${text}`);
  }

  return url;
}

/**
 * 服务端上传任意内容到 OSS（通用版）
 * @param {string} objectName - OSS object key
 * @param {string|Buffer} content - 文件内容
 * @param {string} contentType - MIME 类型
 * @returns {Promise<string>} 公开访问的 URL
 */
async function uploadToOSS(objectName?: any, content?: any, contentType?: any, onProgress?: any) { return _uploadToOSS(objectName, content, contentType, onProgress); }

async function uploadToOSSWithProgress(objectName?: any, content?: any, contentType?: any, onProgress?: any) { return _uploadToOSS(objectName, content, contentType, onProgress); }

async function _uploadToOSS(objectName?: any, content?: any, contentType?: any, onProgress?: any) {
  // The E2E harness exposes a local OSS-compatible PUT endpoint.  It is
  // deliberately opt-in and avoids requiring production credentials in CI.
  if (process.env.VOKO_E2E === '1' && process.env.VOKO_E2E_OSS_BASE_URL) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const url = `${String(process.env.VOKO_E2E_OSS_BASE_URL).replace(/\/$/, '')}/${objectName}`;
    const configuredTimeout = Number(process.env.VOKO_OSS_UPLOAD_TIMEOUT_MS || 30000);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30000;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType || 'application/octet-stream', 'Content-Length': String(buffer?.length || 0) },
      body: buffer,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`OSS 上传失败 (${resp.status}): ${await resp.text()}`);
    return url;
  }
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) {
    throw new Error('OSS AccessKey 未配置');
  }
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const date = new Date().toUTCString();
  const ossHeaders = 'x-oss-object-acl:public-read';
  const resource = `/${OSS_BUCKET}/${objectName}`;
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossHeaders}\n${resource}`;
  const signature = crypto
    .createHmac('sha1', OSS_ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest('base64');

  const url = `https://${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com/${objectName}`;
  const configuredTimeout = Number(process.env.VOKO_OSS_UPLOAD_TIMEOUT_MS || 30000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30000;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `OSS ${OSS_ACCESS_KEY_ID}:${signature}`,
      'Content-Type': contentType,
      'Date': date,
      'Content-Length': String(buffer.length),
      'x-oss-object-acl': 'public-read'
    },
    body: buffer,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OSS 上传失败 (${resp.status}): ${text}`);
  }

  return `${OSS_PUBLIC_URL || OSS_ENDPOINT}/${objectName}`;
}

module.exports = { generateOSSSignature, uploadBase64ToOSS, uploadToOSS, uploadToOSSWithProgress, initOSSFromConfig };
