'use strict';

const { EventEmitter } = require('node:events');
const { VokoIMClient } = require('./client');

class VokoIMHub extends EventEmitter {
  constructor(options = {}) {
    super();
    this.on('error', () => {});
    this.maxConnections = options.maxConnections || 50;
    this.connectDelay = options.connectDelay || 100;
    this.clientFactory = options.clientFactory || ((config) => new VokoIMClient(config));
    this.clients = new Map();
  }

  async add(agentId, config) {
    if (!agentId) throw new Error('agentId is required');
    if (this.clients.has(agentId)) throw new Error(`Agent already exists: ${agentId}`);
    if (this.clients.size >= this.maxConnections) throw new Error(`Hub capacity exceeded: ${this.maxConnections}`);
    const client = this.clientFactory(config);
    for (const event of ['state', 'connect', 'disconnect', 'reconnecting', 'reconnectExhausted', 'kicked', 'error', 'message', 'sent', 'pong', 'event', 'ackTimeout', 'quarantined']) {
      client.on(event, (data) => this.emit(event, { agentId, data }));
    }
    this.clients.set(agentId, client);
    try { await client.connect(); } catch (error) { this.clients.delete(agentId); client.disconnect(); throw error; }
    return client;
  }

  async addMany(entries) {
    const added = [];
    for (const entry of entries) {
      added.push(await this.add(entry.agentId, entry.config));
      if (this.connectDelay) await new Promise((resolve) => setTimeout(resolve, this.connectDelay));
    }
    return added;
  }

  get(agentId) { return this.clients.get(agentId); }
  status(agentId) { const client = this.get(agentId); return client ? { state: client.state, stats: { ...client.stats } } : null; }
  sendText(agentId, ...args) { return this._required(agentId).sendText(...args); }
  sendImage(agentId, ...args) { return this._required(agentId).sendImage(...args); }
  sendFile(agentId, ...args) { return this._required(agentId).sendFile(...args); }
  sendRaw(agentId, ...args) { return this._required(agentId).sendRaw(...args); }
  _required(agentId) { const client = this.get(agentId); if (!client) throw new Error(`Unknown Agent: ${agentId}`); return client; }
  remove(agentId) { const client = this.clients.get(agentId); if (!client) return false; client.disconnect(); this.clients.delete(agentId); return true; }
  disconnectAll() { for (const client of this.clients.values()) client.disconnect(); this.clients.clear(); }
}

module.exports = { VokoIMHub };
