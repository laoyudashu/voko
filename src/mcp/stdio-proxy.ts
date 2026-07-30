export {};

/**
 * stdio-proxy.js — MCP stdio → HTTP 桥接
 *
 * 让外部 MCP 客户端（Claude Code / Cursor 等）通过 stdio 连接 VOKO，
 * 端口对客户端完全透明：本进程读 DB runtime 获取 Lite 实际监听端口
 * （端口被占时可能与 3100 不同），把 stdin 的 JSON-RPC 转发到 Lite 的 /mcp。
 *
 * mcp.json 配置（替代 url: http://localhost:3100/mcp）：
 *   { "mcpServers": { "voko": { "command": "voko", "args": ["mcp"] } } }
 *
 * 协议：stdin 每行一个 JSON-RPC request → POST /mcp → stdout 每行一个 JSON-RPC response。
 *      notifications（无 id）→ 上游返回 202 无 body，不回写 stdout。
 *
 * 调用：由 index.js 的 `voko mcp` 子命令调用，dbPath 由其提供（resolveDbPath）。
 */

const readline = require('readline');
const { t } = require('../core/i18n');
const {
  detectCurrentAgentInstance,
  detectCurrentAgentType,
} = require('../core/registration-orchestrator');

/** fetch + 超时：用 AbortController + clearTimeout（AbortSignal.timeout 的定时器在 Windows process.exit 残留 libuv handle） */
async function fetchWithTimeout(url?: any, opts?: any, ms: any = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

/**
 * 运行 stdio MCP 代理。
 * @param {string} dbPath - voko.db 路径（用于读 runtime 端口）
 * @param {object} [options]
 * @param {number} [options.port] - 显式端口（测试用），覆盖 runtime 读取
 */
async function runMcpProxy(dbPath?: any, options: any = {}) {
  const { getActiveRuntimePort } = require('../core/runtime-port');
  let targetPort = options.port || getActiveRuntimePort(dbPath);

  if (!targetPort) {
    process.stderr.write(t('cli.mcp.no_runtime') + '\n');
    process.exit(1);
  }

  // baseUrl 按当前 targetPort 动态计算：端口变更（Lite 重启换端口）后下一条消息自动用新端口
  const mcpUrl = () => `http://localhost:${targetPort}/mcp`;
  // 鉴权 token（若 Lite 设置了 VOKO_MCP_TOKEN，本地 stdio 代理同环境需带上）
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.VOKO_MCP_TOKEN) headers['X-VOKO-Token'] = process.env.VOKO_MCP_TOKEN;
  const callerProvider = detectCurrentAgentType();
  const callerInstance = callerProvider ? detectCurrentAgentInstance(callerProvider) : null;
  if (callerProvider) headers['X-VOKO-Caller-Provider'] = callerProvider;
  if (callerInstance) headers['X-VOKO-Caller-Instance'] = callerInstance;

  process.stderr.write(t('cli.mcp.ready', { url: mcpUrl() }) + '\n');

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e: any) {
      process.stderr.write(t('cli.mcp.invalid_json', { msg: e.message }) + '\n');
      continue;
    }

    // 转发到 Lite /mcp
    let res;
    try {
      res = await fetchWithTimeout(mcpUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
      });
    } catch (e: any) {
      // 上游连接失败：端口可能已变（Lite 重启换端口），重读一次 runtime 再试
      const retryPort = options.port || getActiveRuntimePort(dbPath);
      if (retryPort && retryPort !== targetPort) {
        targetPort = retryPort;
        process.stderr.write(t('cli.mcp.port_changed', { port: targetPort }) + '\n');
        try {
          res = await fetchWithTimeout(mcpUrl(), {
            method: 'POST', headers, body: JSON.stringify(msg),
          });
        } catch (e2: any) {
          if (msg.id !== undefined) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: t('cli.mcp.forward_failed', { msg: e2.message }) } }) + '\n');
          }
          continue;
        }
      } else {
        if (msg.id !== undefined) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: t('cli.mcp.forward_failed', { msg: e.message }) } }) + '\n');
        }
        continue;
      }
    }

    // notifications（无 id）→ 上游 202 无 body，不回写
    if (res.status === 202) continue;

    if (!res.ok) {
      if (msg.id !== undefined) {
        const text = await res.text().catch(() => '');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: t('cli.mcp.upstream_http', { status: res.status, text }) } }) + '\n');
      }
      continue;
    }

    try {
      const json = await res.json();
      process.stdout.write(JSON.stringify(json) + '\n');
    } catch (e: any) {
      if (msg.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: t('cli.mcp.parse_failed', { msg: e.message }) } }) + '\n');
      }
    }
  }
}

module.exports = { runMcpProxy };
