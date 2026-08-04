/**
 * base-provider.js — PushProvider 基类（push 通道统一接口）
 *
 * 每种 agent backend 的连接建立（含 spawn gateway 等"侵入"操作）收敛在各自 provider 内，
 * lite 其他模块只通过 dispatcher 调用，不再直接 spawn / 配置 agent。
 *
 * 子类应实现：match / isAvailable / priority / start / push / steer / healthCheck
 * 事件：emit('agent.reply', { agentId, visitorId, content, sessionKey, turnId, replyId })、emit('status', {...})
 *
 * 三个维度（dispatcher 联合判断）：
 *   - match(agentId, meta)：归属判断 —— 该 agent 是不是归我管（backend_type 维度），用来「选」provider
 *   - isAvailable(agentId)：就绪判断 —— 我的通道现在能不能 push（连接/配置维度），决定 push 还是 pull
 *   - priority：同 backend 多 provider 时的先后（数大优先）。长连接（HTTP/WS）设高、CLI 兜底设低。
 * 无 match（不认识/未上报）或 match 但全不就绪 → dispatcher 留库 pull。
 *
 * 注意：provider 不强制继承本类（duck typing）。openclaw 自带事件机制可不继承；
 *       hermes 等天然 extends EventEmitter 的可继承本类获得默认方法。
 */
const { EventEmitter } = require('events');
import type { AgentMeta, ProviderHealth, PushPayload, SessionMode } from './types';

class PushProvider extends EventEmitter {
  /** 路由优先级（数大优先）。子类按通道覆盖：长连接高、CLI 兜底低。默认 0。 */
  get priority() { return 0; }

  /**
   * 协议能力声明。子类覆盖返回支持的协议特性数组，如 ['acp','streaming','tool_call','session_resume']。
   * dispatcher 可据此做进阶路由或能力协商。默认空数组。
   */
  get capabilities(): string[] { return []; }

  /**
   * session 模式声明。
   *   'deterministic-key'  — sessionKey 由 provider 根据 agentId+visitorId 计算得出，无需持久化
   *   'agent-issued-id'    — session ID 由 agent 生成，无法派生，需持久化句柄
   * 默认 'deterministic-key'。dispatcher 据此决定是否调用 _saveSessionHandle。
   */
  get sessionMode(): SessionMode { return 'deterministic-key'; }

  /** 归属判断：该 agent 是否归本 provider 管辖（看 backend_type）。子类必须实现。 */
  match(_agentId: string, _meta?: AgentMeta | null): boolean { return false; }

  /** 就绪判断：该 agent 的 push 通道是否就绪（看连接/配置）。子类必须实现。 */
  isAvailable(_agentId: string): boolean { return false; }

  /** 建立连接（含 spawn gateway）。幂等。 */
  async start(): Promise<void> {}

  /** 断开连接、清理资源。 */
  async stop(): Promise<void> {}

  /**
   * 推送一条访客消息给 agent 后端。
   * @param {{agentId:string,fromUid:string,senderUid?:string,sessionTarget?:string,content:string,rawContent?:string,channelId:string,channelType:number,contentType:number,messageId:string,timestamp:number}} payload
   */
  async push(_payload: PushPayload): Promise<unknown> { throw new Error('push() not implemented'); }

  /**
   * 注入系统消息（owner intervention 等）。子类实现：自行构造 sessionKey 前缀
   * （hermes: / agent:）并处理回复/补偿 emit。
   */
  async steer(_agentId: string, _visitorId: string, _content: string): Promise<unknown> {
    throw new Error('steer() not implemented');
  }

  /**
   * 自检 + 重连（替代散落的 60s 心跳逻辑）。
   * @returns {{ok:boolean,status?:string,uptime?:number,lastActive?:number}|void}
   *   返回 {ok, status} 对象表示健康信息；返回 undefined 表示不做自检。
   */
  async healthCheck(): Promise<ProviderHealth | void> {}

  /** Read-only readiness probe. Implementations must not invoke a model or change Provider configuration. */
  async preflightDelivery(agentId: string): Promise<Record<string, unknown>> {
    const ready = this.isAvailable(agentId);
    return {
      ok: ready,
      status: ready ? 'preflight_passed' : 'unavailable',
      sideEffects: false,
    };
  }

  async getDeliveryReadiness(agentId: string): Promise<Record<string, unknown>> {
    return this.preflightDelivery(agentId);
  }

  /** Optional model-backed test. Providers must require an explicit caller acknowledgement. */
  async runLoopbackTest(_agentId: string, _options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return { ok: false, status: 'unavailable', code: 'LOOPBACK_UNSUPPORTED' };
  }

  async cleanupLoopbackSession(_agentId: string, _sessionId?: string): Promise<Record<string, unknown>> {
    return { ok: true, cleaned: false };
  }
}

module.exports = { PushProvider };
