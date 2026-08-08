import { EventEmitter } from 'events';

interface RuntimeProvider {
  start?(): unknown;
  stop?(): unknown;
  healthCheck?(): unknown;
  setAvailabilityProviderId?(providerId: string): void;
  on?(event: string, handler: (payload: any) => void): unknown;
  off?(event: string, handler: (payload: any) => void): unknown;
  removeListener?(event: string, handler: (payload: any) => void): unknown;
}

export class ProviderRuntimeRegistry extends EventEmitter {
  private started = false;
  private readonly availabilityListeners = new Map<RuntimeProvider, (event: any) => void>();

  constructor(readonly providers: Record<string, RuntimeProvider> = {}) {
    super();
    for (const [id, provider] of Object.entries(providers)) this.attach(id, provider);
  }

  private attach(id: string, provider: RuntimeProvider): void {
    provider.setAvailabilityProviderId?.(id);
    if (this.availabilityListeners.has(provider) || typeof provider.on !== 'function') return;
    const listener = (event: any = {}) => this.emit('availability', { ...event, providerId: id });
    this.availabilityListeners.set(provider, listener);
    provider.on('availability', listener);
  }

  private detach(provider: RuntimeProvider): void {
    const listener = this.availabilityListeners.get(provider);
    if (!listener) return;
    if (typeof provider.off === 'function') provider.off('availability', listener);
    else provider.removeListener?.('availability', listener);
    this.availabilityListeners.delete(provider);
  }

  async add(additions: Record<string, RuntimeProvider>): Promise<string[]> {
    const added: string[] = [];
    for (const [id, provider] of Object.entries(additions)) {
      if (this.providers[id]) continue;
      this.providers[id] = provider;
      this.attach(id, provider);
      if (this.started) {
        try { await provider.start?.(); }
        catch (error) { this.emit('providerError', { providerId: id, operation: 'start', error }); }
      }
      added.push(id);
    }
    return added;
  }

  async startAll(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const [id, provider] of Object.entries(this.providers)) {
      this.attach(id, provider);
      try { await provider.start?.(); }
      catch (error) { this.emit('providerError', { providerId: id, operation: 'start', error }); }
    }
  }

  async stopAll(): Promise<void> {
    this.started = false;
    for (const [id, provider] of Object.entries(this.providers)) {
      this.detach(provider);
      try { await provider.stop?.(); }
      catch (error) { this.emit('providerError', { providerId: id, operation: 'stop', error }); }
    }
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [id, provider] of Object.entries(this.providers)) {
      try { result[id] = await provider.healthCheck?.(); }
      catch (error) {
        result[id] = { ok: false, error: error instanceof Error ? error.message : String(error) };
        this.emit('providerError', { providerId: id, operation: 'healthCheck', error });
      }
    }
    return result;
  }
}

module.exports = { ProviderRuntimeRegistry };
