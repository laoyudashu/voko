interface MailboxItem { eventId: string; taskId: string; envelope: unknown }
interface MailboxClaim { leaseId: string; items: MailboxItem[] }
interface A2AMailboxClientOptions { baseUrl: string; token: string; fetchImpl?: typeof fetch }

function normalizeMailboxBaseUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('A2A Mailbox requires HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/$/, '');
}

class A2AMailboxClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  constructor(options: A2AMailboxClientOptions) {
    if (options.token.length < 32) throw new Error('Invalid A2A Mailbox device token');
    this.baseUrl = normalizeMailboxBaseUrl(options.baseUrl);
    this.token = options.token; this.fetchImpl = options.fetchImpl || fetch;
  }
  private async post(path: string, body: unknown): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
    if (!response.ok) { const error = new Error(`A2A Mailbox request failed (${response.status})`); (error as any).status = response.status; throw error; }
    return response.json();
  }
  private async get(path: string): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET',
      headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { const error = new Error(`A2A Mailbox request failed (${response.status})`); (error as any).status = response.status; throw error; }
    return response.json();
  }
  async claim(limit = 20): Promise<MailboxClaim> {
    const result = await this.post('/claim', { limit });
    if (!result || typeof result.leaseId !== 'string' || !Array.isArray(result.items)) throw new Error('Invalid A2A Mailbox claim');
    return result;
  }
  async acknowledge(leaseId: string, eventId: string): Promise<void> {
    await this.post('/ack', { leaseId, eventId });
  }
  async sendEvent(envelope: unknown): Promise<{ status: string; gatewaySequence?: number }> {
    return this.post('/events', envelope);
  }
  async findEvent(eventId: string): Promise<{ found: boolean; taskId?: string; gatewaySequence?: number }> {
    return this.get(`/events/${encodeURIComponent(eventId)}`);
  }
}

export { A2AMailboxClient, normalizeMailboxBaseUrl };
export type { A2AMailboxClientOptions, MailboxClaim, MailboxItem };
