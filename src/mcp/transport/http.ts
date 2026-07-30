export {};

/**
 * VOKO MCP — 纯 HTTP JSON-RPC 传输（StreamableHTTP 兼容）
 *
 * 自写 HTTP transport，不自用 SDK 的 server.connect()。
 * 直接解析 JSON-RPC 报文，转发给 McpServer 处理。
 *
 * 端点：
 *   POST /mcp — JSON-RPC 工具调用（initialize / tools/list / tools/call / notifications）
 */

const { Router } = require('express');
const { normalizeBackendType } = require('../../core/agent-backend-types');
const { runWithRegistrationCaller } = require('../../core/registration-caller-context');

const MCP_VERSION = '2025-11-25';
const SERVER_NAME = 'voko';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp').McpServer} mcpServer
 * @param {Object} [options]
 * @param {string} [options.version]
 * @param {import('better-sqlite3').Database} [options.db] - 用于 initialize 时写 agents.backend_type
 * @returns {Router}
 */
function createHttpTransport(mcpServer?: any, options: any = {}) {
  const router = Router();
  const version = options.version || '0.2.14';
  const db = options.db || null;

  // ─── POST /mcp — JSON-RPC 请求 ───
  router.post('/', async (req?: any, res?: any) => {
    const msg = req.body;
    if (!msg || !msg.jsonrpc) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: invalid JSON-RPC' },
        id: null,
      });
    }

    // ── initialize ──
    if (msg.method === 'initialize') {
      // runtime 主动上报 backend（约定：_meta 同时带 backend + agentId 才写库，二者缺一不可）。
      // 纯增量：runtime 没发就什么都不做（backend_type 维持注册时值，未上报→'others'→留库 pull）。
      // 不做 clientInfo.name 推断，避免把不认识的 runtime 误判成 openclaw/hermes 错推。
      const meta = msg.params?._meta;
      const backend = meta?.backend;
      const agentId = meta?.agentId;
      if (db && backend && agentId) {
        try {
          db.prepare('UPDATE agents SET backend_type=?, updated_at=? WHERE agent_id=?')
            .run(normalizeBackendType(backend), Date.now(), String(agentId));
          try { (global as any).__dispatcher?.invalidateMeta?.(String(agentId)); } catch (_: any) {}
        } catch (e: any) {
          console.error('[MCP transport] 写 backend_type 失败:', e.message);
        }
      }
      return res.json({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: MCP_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version,
          },
        },
      });
    }

    // ── notifications（无 id，不需要回复） ──
    if (!msg.id) {
      return res.status(202).end();
    }

    // ── tools/list ──
    if (msg.method === 'tools/list') {
      const handler = mcpServer.server._requestHandlers.get('tools/list');
      if (handler) {
        const result = await handler({ method: 'tools/list', params: {} });
        return res.json({ jsonrpc: '2.0', id: msg.id, result });
      }
      return res.json({ jsonrpc: '2.0', error: { code: -32603, message: 'tools/list handler not found' }, id: msg.id });
    }

    // ── tools/call ──
    if (msg.method === 'tools/call') {
      const handler = mcpServer.server._requestHandlers.get('tools/call');
      if (handler) {
        try {
          const rawProvider = String(req.headers['x-voko-caller-provider'] || '');
          const providerType = normalizeBackendType(rawProvider);
          const allowedProviders = new Set([
            'openclaw', 'zeroclaw', 'hermes', 'goose', 'claude-code', 'codex',
            'gemini', 'opencode', 'zcode', 'workbuddy', 'doubao',
            'cursor', 'grok', 'pi',
          ]);
          const caller = allowedProviders.has(providerType)
            ? {
                providerType,
                instanceId: String(req.headers['x-voko-caller-instance'] || '').slice(0, 160) || null,
              }
            : null;
          const result = await runWithRegistrationCaller(
            caller,
            () => handler({ method: 'tools/call', params: msg.params }),
          );
          return res.json({ jsonrpc: '2.0', id: msg.id, result });
        } catch (e: any) {
          return res.json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: msg.id });
        }
      }
      return res.json({ jsonrpc: '2.0', error: { code: -32603, message: 'tools/call handler not found' }, id: msg.id });
    }

    // ── 未知 method ──
    return res.json({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method not found: ${msg.method}` },
      id: msg.id,
    });
  });

  return router;
}

module.exports = { createHttpTransport };
