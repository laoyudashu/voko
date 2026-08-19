interface MailboxItem { eventId: string; taskId: string; envelope: unknown }
interface MailboxClaim { leaseId: string; items: MailboxItem[] }
interface OutboundResultItem { eventId: string; taskId: string; sequence: number; payload: any }
interface AgentAvailabilitySnapshot { localAgentId: string; bindingGeneration: number; snapshotSequence: number;
  state: 'available' | 'degraded' | 'queueing' | 'unavailable' | 'unknown' }
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
  private async responseError(response: Response): Promise<Error> {
    let payload: any = null;
    try { payload = await response.json(); } catch (_) {}
    const error = new Error(`A2A Mailbox request failed (${response.status})`);
    (error as any).status = response.status;
    (error as any).code = typeof payload?.error?.code === 'string' ? payload.error.code : undefined;
    (error as any).expectedSequence = Number.isSafeInteger(Number(payload?.error?.expectedSequence))
      ? Number(payload.error.expectedSequence) : undefined;
    return error;
  }
  private async post(path: string, body: unknown): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
    if (!response.ok) throw await this.responseError(response);
    return response.json();
  }
  private async get(path: string): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET',
      headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw await this.responseError(response);
    return response.json();
  }
  async claim(limit = 20, agentStatuses: AgentAvailabilitySnapshot[] = []): Promise<MailboxClaim> {
    const result = await this.post('/claim', { limit, agentStatuses });
    if (!result || typeof result.leaseId !== 'string' || !Array.isArray(result.items)) throw new Error('Invalid A2A Mailbox claim');
    return result;
  }
  async acknowledge(leaseId: string, eventId: string): Promise<void> {
    await this.post('/ack', { leaseId, eventId });
  }
  async downloadAttachment(taskId:string,attachmentId:string):Promise<Response>{
    const response=await this.fetchImpl(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      {method:'GET',headers:{authorization:`Bearer ${this.token}`},signal:AbortSignal.timeout(60_000)});
    if(!response.ok)throw await this.responseError(response);return response;
  }
  async sendEvent(envelope: unknown): Promise<{ status: string; gatewaySequence?: number }> {
    return this.post('/events', envelope);
  }
  async findEvent(eventId: string): Promise<{ found: boolean; taskId?: string; gatewaySequence?: number }> {
    return this.get(`/events/${encodeURIComponent(eventId)}`);
  }
  async discoverRemote(localAgentId: string, cardUrl: string, credential?: string): Promise<any> {
    return this.post('/remote/discover', { localAgentId, cardUrl, ...(credential ? { credential } : {}) });
  }
  async sendOutbound(input: { localAgentId: string; remoteAgentKey: string; text: string; messageId?: string; idempotencyKey?: string }): Promise<any> {
    return this.post('/outbound/send', input);
  }
  async getOutboundTask(taskId: string): Promise<any> {
    return this.get(`/outbound/tasks/${encodeURIComponent(taskId)}`);
  }
  async cancelOutboundTask(localAgentId: string, taskId: string): Promise<any> {
    return this.post(`/outbound/tasks/${encodeURIComponent(taskId)}:cancel`, { localAgentId });
  }
  async listOutboundTasks(): Promise<any[]> {
    const result = await this.get('/outbound/tasks'); return Array.isArray(result?.tasks) ? result.tasks : [];
  }
  async listInboundTasks(localAgentId?: string): Promise<any[]> {
    const query = localAgentId ? `?localAgentId=${encodeURIComponent(localAgentId)}` : '';
    const result = await this.get(`/tasks${query}`); return Array.isArray(result?.tasks) ? result.tasks : [];
  }
  async getInboundTask(taskId: string): Promise<any> {
    const result = await this.get(`/tasks/${encodeURIComponent(taskId)}`); return result?.task || null;
  }
  async cancelInboundTask(taskId: string): Promise<any> {
    return this.post(`/tasks/${encodeURIComponent(taskId)}:cancel`, {});
  }
  async uploadArtifact(taskId: string, input: { artifactId: string; partIndex: number; raw: string;
    mediaType: string; filename?: string; sha256?: string }): Promise<any> {
    const result = await this.post(`/tasks/${encodeURIComponent(taskId)}/artifacts`, input);
    return result?.artifact;
  }
  async getDiagnosticsSummary(): Promise<any> {
    const result = await this.get('/diagnostics/summary'); return result?.diagnostics || null;
  }
  async claimOutboundResults(limit = 20): Promise<{ leaseId: string; items: OutboundResultItem[] }> {
    return this.post('/outbound/results/claim', { limit });
  }
  async acknowledgeOutboundResult(leaseId: string, eventId: string): Promise<void> {
    await this.post('/outbound/results/ack', { leaseId, eventId });
  }
}

export { A2AMailboxClient, normalizeMailboxBaseUrl };
export type { A2AMailboxClientOptions, AgentAvailabilitySnapshot, MailboxClaim, MailboxItem, OutboundResultItem };
