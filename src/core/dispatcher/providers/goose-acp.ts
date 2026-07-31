/**
 * goose-acp.js — Goose ACP Provider
 *
 * 通过 goose acp（stdio ACP）与 Goose AI 通信。
 *
 * backend_type: 'acp-goose'
 * priority: 10
 *
 * ACP 失败时自动降级到 goose CLI（复用 goose-cli 的完整调用 + 回复解析）。
 * 注意：dispatcher 选定 provider 后不会跨 provider 重试，所以「goose-cli 兜底」必须
 * 在本 provider 内部实现——ACP 一旦失败，本进程后续直接走 CLI（latch，避免每条消息
 * 都重试坏掉的 ACP）。
 */

const { AcpAdapter } = require('../../adapters/acp-adapter');
const GooseCliProvider = require('./goose-cli');
const { resolveGooseCommand } = require('../goose-command');
import type { PushPayload } from '../types';
import type { GooseCliOptions } from './goose-cli';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class GooseAcpProvider extends AcpAdapter {
  constructor(options: GooseCliOptions = {}) {
    super({
      name: 'GOOSE ACP',
      matchType: 'acp-goose',
      cliPath: options.binPath || resolveGooseCommand(),
      args: ['acp'],
      db: options.db,
      contextWindow: options.contextWindow,
    });
    // ACP 失败降级：复用 goose-cli 的完整调用（session/resume）+ JSON 回复解析。
    // 把 goose-cli 的 agent.reply 事件转发到本 provider，让 dispatcher（监听 goose-acp）能收到。
    this._cli = new GooseCliProvider(options);
    this._cli.on('agent.reply', (...args: unknown[]) => this.emit('agent.reply', ...args));
    this._acpDisabled = false;
  }

  async push(payload: PushPayload): Promise<void> {
    // ACP 未失败过 → 先试 ACP
    if (!this._acpDisabled) {
      try {
        await this._pushViaAcp(payload);
        return;
      } catch (err) {
        console.error(`[GOOSE ACP:${payload.agentId}] ACP 失败，降级到 goose CLI（本进程后续直接走 CLI）: ${errorMessage(err)}`);
        this._acpDisabled = true;
        try { await this.stop(); } catch (_) {} // 清理已建立的 ACP 子进程
      }
    }
    // ACP 失败过 或 上方刚失败 → 直接走 goose CLI
    return this._cli.push(payload);
  }
}

module.exports = { GooseAcpProvider };
