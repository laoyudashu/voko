const crypto = require('node:crypto');
const WebSocket = require('ws');

/** Public DSH Remote transport. Cookies stay in memory and are never included in errors. */
export class DeepSeekHarnessRemote {
  private cookie = '';
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 5000, private WebSocketImpl: any = WebSocket) {}

  async authenticate(launchUrl: string): Promise<void> {
    const url = new URL(launchUrl);
    if (url.origin !== this.baseUrl || url.pathname !== '/' || !url.searchParams.has('token')) {
      throw new Error('DSH authentication URL must belong to the configured loopback origin');
    }
    const response = await this.fetchImpl(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    const cookies = response.headers.getSetCookie();
    if (response.status !== 303 || cookies.length === 0) throw new Error('DSH authentication failed');
    this.cookie = cookies.map(value => value.split(';')[0]).join('; ');
  }

  async call(method: string, args: Record<string, unknown>): Promise<any> {
    const rpcId = crypto.randomUUID();
    const response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw Object.assign(new Error(`DSH HTTP ${response.status}`), { httpStatus: response.status });
    const body: any = await response.json();
    if (body?.type !== 'server-response' || body.rpcId !== rpcId) throw new Error('DSH invalid RPC envelope');
    if (body.result?.ok !== true) throw Object.assign(new Error('DSH Remote request rejected'),
      { rpcCode: body.result?.error?.code || 'internal' });
    return body.result.value;
  }

  /** Read the opening snapshot, then close the public stream. No Owner event/approval subscription. */
  snapshot(sessionId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.baseUrl.replace(/^http:/, 'ws:') + '/api/remote.mux', {
        headers: this.cookie ? { Cookie: this.cookie } : {}, maxPayload: 16 * 1024 * 1024,
      });
      const streamId = crypto.randomUUID();
      let settled = false;
      const finish = (error?: Error, value?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }));
          socket.close();
        } else socket.terminate();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('DSH snapshot timed out')), this.timeoutMs);
      socket.on('error', () => finish(new Error('DSH snapshot connection failed')));
      socket.on('close', () => finish(new Error('DSH snapshot closed before opening')));
      socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 50 } } } })));
      socket.on('message', (data: any) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.streamId !== streamId) return;
          if (frame.type === 'error') return finish(new Error('DSH snapshot request rejected'));
          if (frame.type === 'item' && frame.value?.type === 'snapshot') {
            const value = frame.value;
            if (value.header?.id !== sessionId || !Array.isArray(value.records) || !Number.isInteger(value.cursor)) {
              return finish(new Error('DSH invalid snapshot'));
            }
            finish(undefined, value);
          }
        } catch { finish(new Error('DSH invalid stream frame')); }
      });
    });
  }
}
