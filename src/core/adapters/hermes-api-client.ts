const http = require('http');
const { EventEmitter } = require('events');
import type { IncomingHttpHeaders } from 'http';

interface HermesProfile {
  port?: number;
}

type HermesProfiles = Record<string, HermesProfile>;

export interface HermesApiClientOptions {
  host?: string;
  port?: number;
  apiKey?: string;
  profiles?: HermesProfiles;
}

interface ConnectionOverrides {
  host?: string;
  port?: number;
}

interface HermesCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface HermesChatResult {
  reply: string;
  runId: string;
  sessionKey: string;
}

export interface HermesSteerResult {
  accepted: true;
  output: string;
  sessionKey: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8642;
const CHAT_TIMEOUT = 120000;
const PING_TIMEOUT = 5000;

// 从配置的 profiles 映射中查询端口
function profilePort(profileName: string, profiles?: HermesProfiles): number {
  const entry = profiles?.[profileName];
  return entry?.port || DEFAULT_PORT;
}

/** 日志脱敏：apiKey 只显示前8位 */
function _keyLog(k: string): string {
  return k ? `"${k.substring(0, 8)}..." (len=${k.length})` : '(空)';
}

class HermesApiClient extends EventEmitter {
  _healthTimer: NodeJS.Timeout | null;

  constructor(options: HermesApiClientOptions = {}) {
    super();
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.apiKey = options.apiKey || '';
    this.profiles = options.profiles || {};  // { agentId: { port } }
    this.connected = false;
    this._destroyed = false;
    this._healthTimer = null;
  }

  _agentPort(agentId: string): number {
    return this.profiles?.[agentId]?.port || this.port;
  }

  _request(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    extraHeaders: IncomingHttpHeaders = {},
    connOverrides: ConnectionOverrides = {},
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const options = {
        hostname: connOverrides.host || this.host,
        port: connOverrides.port || this.port,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...extraHeaders
        }
      };

      const req = http.request(options, (res: import('http').IncomingMessage) => {
        let buf = '';
        res.on('data', (chunk: Buffer | string) => { buf += chunk.toString(); });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            if (statusCode === 401) {
              console.warn(`[HermesApiClient] 401 ${method} ${path} port=${options.port} apiKey=${_keyLog(this.apiKey)}`);
            }
            reject(new Error(`HTTP ${statusCode}: ${buf.substring(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            resolve(buf);
          }
        });
      });

      req.on('error', (err: Error) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });

      if (data) req.write(data);
      req.end();
    });
  }

  _sessionKey(agentId: string, visitorId: string): string {
    return `hermes:${agentId}:${visitorId}`;
  }

  /**
   * 发送聊天消息并等待回复
   */
  async chat(
    agentId: string,
    visitorId: string,
    message: string,
    timeoutMs?: number,
  ): Promise<HermesChatResult> {
    const sessionId = this._sessionKey(agentId, visitorId);
    const enriched = `[访客 ${visitorId}]: ${message}`;
    const conn = { port: this._agentPort(agentId) };
    console.log(`[HermesApiClient] chat agentId=${agentId} port=${conn.port} apiKey=${_keyLog(this.apiKey)}`);

    const resp = await this._request('POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: enriched }],
      model: 'hermes-agent',
      stream: false
    }, timeoutMs || CHAT_TIMEOUT, { 'X-Hermes-Session-Id': sessionId }, conn) as HermesCompletionResponse;

    const reply = resp?.choices?.[0]?.message?.content || '';
    return { reply, runId: resp?.id || '', sessionKey: sessionId };
  }

  /**
   * 注入系统消息到会话
   */
  async steer(agentId: string, visitorId: string, content: string): Promise<HermesSteerResult> {
    const sessionId = this._sessionKey(agentId, visitorId);
    const enriched = `[系统消息] ${content}`;
    const conn = { port: this._agentPort(agentId) };

    const resp = await this._request('POST', '/v1/chat/completions', {
      messages: [
        { role: 'system', content: `[Owner Instruction] ${content}` },
        { role: 'user', content: enriched }
      ],
      model: 'hermes-agent',
      stream: false
    }, CHAT_TIMEOUT, { 'X-Hermes-Session-Id': sessionId }, conn) as HermesCompletionResponse;

    const output = resp?.choices?.[0]?.message?.content || '';
    return { accepted: true, output, sessionKey: sessionId };
  }

  /**
   * 健康检查
   */
  async ping(agentId?: string): Promise<boolean> {
    try {
      const conn = agentId ? { port: this._agentPort(agentId) } : {};
      await this._request('GET', '/health', null, PING_TIMEOUT, {}, conn);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 定期健康检查 + 状态发射
   */
  startHealthCheck(intervalMs = 30000): void {
    this.stopHealthCheck();
    const check = async () => {
      const ok = await this.ping();
      if (ok !== this.connected) {
        this.connected = ok;
        this.emit('status', { connected: ok });
      }
    };
    check().then(() => {
      if (this.connected) this.emit('ready');
    });
    this._healthTimer = setInterval(check, intervalMs);
  }

  stopHealthCheck(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  destroy(): void {
    this._destroyed = true;
    this.stopHealthCheck();
    this.removeAllListeners();
  }
}

module.exports = { HermesApiClient };
