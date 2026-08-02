'use strict';

const { EventEmitter } = require('node:events');
const { VokoIMHub } = require('./hub');

class VokoIMHubPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxConnectionsPerHub = options.maxConnectionsPerHub || 20;
    this.connectDelay = options.connectDelay ?? 100;
    this.clientFactory = options.clientFactory;
    this.hubs = [];
    this.agentRoutes = new Map();
    this.on('error', () => {});
  }

  _createHub() {
    const hub = new VokoIMHub({ maxConnections: this.maxConnectionsPerHub, connectDelay: this.connectDelay, clientFactory: this.clientFactory });
    const hubIndex = this.hubs.length;
    for (const event of ['state', 'connect', 'disconnect', 'reconnecting', 'reconnectExhausted', 'kicked', 'error', 'message', 'sent', 'pong', 'event', 'ackTimeout', 'quarantined']) {
      hub.on(event, (payload) => this.emit(event, { hubIndex, ...payload }));
    }
    this.hubs.push(hub);
    return { hub, hubIndex };
  }

  async add(agentId, config) {
    if (this.agentRoutes.has(agentId)) throw new Error(`Agent already exists: ${agentId}`);
    let hubIndex = this.hubs.findIndex((hub) => hub.clients.size < this.maxConnectionsPerHub);
    let hub;
    if (hubIndex < 0) ({ hub, hubIndex } = this._createHub());
    else hub = this.hubs[hubIndex];
    let client;
    try { client = await hub.add(agentId, config); }
    catch (error) {
      if (hub.clients.size === 0 && hubIndex === this.hubs.length - 1) this.hubs.pop();
      throw error;
    }
    this.agentRoutes.set(agentId, hubIndex);
    return client;
  }

  get(agentId) { const index = this.agentRoutes.get(agentId); return index === undefined ? undefined : this.hubs[index].get(agentId); }
  route(agentId) { return this.agentRoutes.get(agentId); }
  status(agentId) { const index = this.agentRoutes.get(agentId); return index === undefined ? null : { hubIndex: index, ...this.hubs[index].status(agentId) }; }
  remove(agentId) { const index = this.agentRoutes.get(agentId); if (index === undefined) return false; this.agentRoutes.delete(agentId); const removed = this.hubs[index].remove(agentId); while (this.hubs.length && this.hubs.at(-1).clients.size === 0) this.hubs.pop(); return removed; }
  sendText(agentId, ...args) { return this._hub(agentId).sendText(agentId, ...args); }
  sendImage(agentId, ...args) { return this._hub(agentId).sendImage(agentId, ...args); }
  sendFile(agentId, ...args) { return this._hub(agentId).sendFile(agentId, ...args); }
  sendRaw(agentId, ...args) { return this._hub(agentId).sendRaw(agentId, ...args); }
  _hub(agentId) { const index = this.agentRoutes.get(agentId); if (index === undefined) throw new Error(`Unknown Agent: ${agentId}`); return this.hubs[index]; }
  summary() { return { hubCount: this.hubs.length, agentCount: this.agentRoutes.size, hubs: this.hubs.map((hub, index) => ({ index, agentCount: hub.clients.size, agents: [...hub.clients.keys()] })) }; }
  disconnectAll() { this.hubs.forEach((hub) => hub.disconnectAll()); this.hubs = []; this.agentRoutes.clear(); }
}

module.exports = { VokoIMHubPool };
