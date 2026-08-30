import type { E2eeV2PublicBundle } from './v2-wasm';

export function isTransientE2eeDirectoryError(value: unknown): boolean {
  const row=value as any;
  const code=String(row?.code||row?.message||value||'');
  if (['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ABORT_ERR',
    'E2EE_V2_DIRECTORY_UNAVAILABLE','E2EE_V2_DIRECTORY_TIMEOUT'].includes(code)) return true;
  if (/^E2EE_V2_DIRECTORY_HTTP_(?:408|425|429|5\d\d)$/.test(code)) return true;
  return row?.name === 'TimeoutError' || row?.name === 'AbortError';
}

export function isRevalidatableE2eeDirectoryError(value: unknown): boolean {
  const row=value as any;
  const code=String(row?.code||row?.message||value||'');
  return ['PEER_NOT_FOUND','E2EE_KEY_NOT_FOUND','E2EE_V2_DIRECTORY_HTTP_404'].includes(code)
    ||isTransientE2eeDirectoryError(value);
}

function bounded(value: unknown, name: string, max = 2048): string {
  const result = String(value || '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`E2EE_V2_DIRECTORY_INVALID_${name}`);
  }
  return result;
}

export class E2eeV2DirectoryClient {
  private readonly baseUrl: string;
  constructor(private readonly options: {
    baseUrl: string;
    token: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = bounded(options.baseUrl,'BASE_URL',2048).replace(/\/+$/,'');
    if (!/^https:\/\//i.test(this.baseUrl)
        && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(this.baseUrl)) {
      throw new Error('E2EE_V2_DIRECTORY_HTTPS_REQUIRED');
    }
    bounded(options.token,'TOKEN',8192);
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<any> {
    const effectiveTimeoutMs=timeoutMs || this.options.timeoutMs || 10_000;
    let response:Response;
    try{
      response = await (this.options.fetchImpl || fetch)(`${this.baseUrl}/api/external${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: 'application/json',
          ...(init.body ? { 'content-type':'application/json' } : {}),
          ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    }catch(value){
      const source:any=value instanceof Error?value:new Error(String(value));
      if(source.name==='TimeoutError' || source.name==='AbortError'){
        const error:any=new Error(source.message,{cause:source});
        error.name=source.name;
        error.code='E2EE_V2_DIRECTORY_TIMEOUT';
        error.causeCode=source.code;
        error.operation=path;
        error.timeoutMs=effectiveTimeoutMs;
        throw error;
      }
      source.operation=path;
      source.timeoutMs=effectiveTimeoutMs;
      throw source;
    }
    let body: any = null;
    try { body = await response.json(); } catch {}
    if (!response.ok || !body?.success) {
      const error: any = new Error(String(body?.error?.message || body?.message || `E2EE directory HTTP ${response.status}`));
      error.code = String(body?.error?.code || body?.code || `E2EE_V2_DIRECTORY_HTTP_${response.status}`);
      error.status = response.status;
      error.operation = path;
      if (response.status === 429) {
        const seconds = Number.parseInt(response.headers.get('retry-after') || '',10);
        error.retryAfterMs = Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds,300)*1000 : 60_000;
      }
      throw error;
    }
    return body.data;
  }

  status(): Promise<any> { return this.request('/v1/e2ee/status'); }

  registerAgentKey(input: {
    agentId: string;
    deviceId: string;
    generation: number;
    publicBundle: E2eeV2PublicBundle;
  }): Promise<any> {
    return this.request('/v1/e2ee/agent-keys',{ method:'POST',body:JSON.stringify(input) });
  }

  revokeAgentKey(input: { agentId:string;deviceId:string }): Promise<any> {
    return this.request('/v1/e2ee/agent-keys/revoke',{ method:'POST',body:JSON.stringify(input) });
  }

  resolveGuestKey(input: { agentId:string;deviceId:string;keyId:string }): Promise<{
    agentId:string;agentDid:string;deviceId:string;generation:number;publicBundle:E2eeV2PublicBundle;
  }> {
    return this.request('/v1/e2ee/guest-keys/resolve',{ method:'POST',body:JSON.stringify(input) });
  }

  resolveRecipients(input: {
    senderAgentId:string;
    targetImUid:string;
    conversationKey?:string;
  }): Promise<{
    peerKind:'guest'|'agent';
    peerScopeId:string;
    peerAgentDid?:string;
    capability:'supported'|'unsupported'|'temporarily_unavailable';
    protocolConversationId:string|null;
    revision:string;
    expiresAt:number;
    recipients:Array<{deviceId:string;generation:number;keyId:string;publicBundle:E2eeV2PublicBundle}>;
  }> {
    return this.request('/v1/e2ee/recipients/resolve', {
      method:'POST',body:JSON.stringify(input),
    }, 1_200);
  }

  resolveSender(input: {
    localAgentId:string;
    fromUid:string;
    senderDeviceId:string;
    senderKeyId:string;
    conversationKey?:string;
  }): Promise<{
    peerKind:'guest'|'agent';
    peerScopeId:string;
    protocolConversationId:string|null;
    sender:{deviceId:string;generation:number;keyId:string;publicBundle:E2eeV2PublicBundle};
  }> {
    return this.request('/v1/e2ee/senders/resolve', {
      method:'POST',body:JSON.stringify(input),
    }, 1_200);
  }
}

module.exports = { E2eeV2DirectoryClient, isRevalidatableE2eeDirectoryError, isTransientE2eeDirectoryError };
