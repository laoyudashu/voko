export {};

/**
 * Agent Worker - 每个 Agent 的独立 WuKongIM 连接进程
 *
 * 通过 fork 启动，每个 worker 有独立的 V8 实例和 WKSDK.shared() 实例
 * 用法: node agent-worker.js <agentId> <configJson>
 */

// 日志统一到 voko-im.log：worker 不再自写文件，console 经 fork stdio 继承到 Lite 主进程统一写
// 过滤 WKSDK 内部 RecvPacket dump，避免与 Lite 的 [通知] 日志重复
console.log = () => {};
type DynamicSdkValue = any;
interface WorkerConfig { uid?: string; token?: string; serverUrl?: string }
interface Mention { all?: boolean; uids?: string[] }
interface FilePayload { url?: string; name?: string; size?: number; type?: string }
interface PendingSend {
  agentId: string;
  channelId: string;
  localMsgId: string;
  clientMsgNo: string | null;
}
interface LegacyWorkerRequest {
  type: 'send' | 'disconnect' | 'ping';
  channelId?: string;
  content?: string;
  messageType?: string;
  localMsgId?: string;
  channelType?: number;
  mentions?: Mention | null;
}
interface RpcWorkerRequest {
  type: 'req';
  method: string;
  params?: Omit<LegacyWorkerRequest, 'type'>;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function workerLog(...args: unknown[]): void { console.log(...args); }
function workerErr(...args: unknown[]): void { console.error(...args); }

// 父进程退出/kill 后 IPC 通道关闭，裸 process.send 会抛 ERR_IPC_CHANNEL_CLOSED，统一兜底
function safeSend(m: object): void { try { process.send?.(m); } catch (_) { /* IPC channel closed */ } }

// 获取命令行参数
const agentId = process.argv[2];
let config: WorkerConfig = {};
try {
  config = JSON.parse(process.argv[3] || '{}');
} catch (e) {
  workerErr(`[${agentId || 'unknown'}] 解析 config JSON 失败:`, errorMessage(e), '原始参数:', process.argv[3]);
  process.exit(1);
}

const { uid, token, serverUrl } = config;


if (!agentId || !uid || !token || !serverUrl) {
  workerErr(`[${agentId || 'unknown'}] Worker 启动参数不足`, { agentId, uid, token, serverUrl });
  process.exit(1);
}

// Node.js 环境没有全局 WebSocket，用 ws 模块 polyfill
if (typeof WebSocket === 'undefined') {
  try {
    const WS = require('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WS;
  } catch (err) {
    workerErr(`[${agentId}] 加载 ws 模块失败:`, errorMessage(err), err instanceof Error ? err.stack : undefined);
    process.exit(1);
  }
} else {
}

// 加载 SDK
let WKSDK: DynamicSdkValue;
let MessageText: DynamicSdkValue;
let MessageImage: DynamicSdkValue;
let Channel: DynamicSdkValue;
let ChannelTypePerson: DynamicSdkValue;
let ChannelTypeGroup: DynamicSdkValue;
let MessageFile: DynamicSdkValue;
try {
  const wukongim = require('wukongimjssdk');
  WKSDK = wukongim.WKSDK;
  MessageText = wukongim.MessageText;
  MessageImage = wukongim.MessageImage;
  Channel = wukongim.Channel;
  ChannelTypePerson = wukongim.ChannelTypePerson;
  ChannelTypeGroup = wukongim.ChannelTypeGroup;
  try {
    MessageFile = require('./message-content').MessageFile;
  } catch (err) {
    workerErr(`[${agentId}] 加载 MessageFile 失败:`, errorMessage(err));
  }
} catch (err) {
  workerErr(`[${agentId}] 加载 wukongimjssdk 失败:`, errorMessage(err), err instanceof Error ? err.stack : undefined);
  process.exit(1);
}

// 初始化 SDK
let sdk: DynamicSdkValue;
try {
  sdk = WKSDK.shared();
  sdk.config.uid = uid;
  sdk.config.token = token;
  sdk.config.addr = serverUrl;
  sdk.config.autoReconnect = true; // SDK 内置自动重连，退出手动管理避免冲突

  // 注册自定义文件消息类型（contentType=4），确保收发都能正确编解码
  if (MessageFile) {
    try {
      WKSDK.shared().messageContentManager.register(4, MessageFile);
    } catch (err) {
      workerErr(`[${agentId}] 注册 MessageFile 失败:`, errorMessage(err));
    }
  }
} catch (err) {
  workerErr(`[${agentId}] WKSDK 初始化失败:`, errorMessage(err), err instanceof Error ? err.stack : undefined);
  process.exit(1);
}

// 状态映射（与 SDK ConnectStatus 枚举一致）
// ConnectStatus: 0=Disconnect 1=Connected 2=Connecting 3=ConnectFail 4=ConnectKick
const statusMap: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'connectFail',
  4: 'kicked'
};

// 连接状态监听（仅上报，重连由 SDK 内置的 autoReconnect 处理）
sdk.connectManager.addConnectStatusListener((status: number) => {
  const statusText = statusMap[status] || 'unknown';
  workerLog(`[${agentId}] 连接状态: ${statusText}`);
  safeSend({
    type: 'status',
    agentId,
    status: statusText,
    statusCode: status
  });
});

// 消息监听
sdk.chatManager.addMessageListener((rawMsg: DynamicSdkValue) => {
  // 如果是自己发的消息，跳过（避免回声）
  if (rawMsg.fromUID === uid) {
    return;
  }

  // contentType 99 是命令消息，跳过不处理
  if (rawMsg.contentType === 99) {
    return;
  }


  // 提取消息字段
  const fromUid = rawMsg.fromUID;
  const toUid = rawMsg.toUID || uid;
  const channelId = rawMsg.channel?.channelID || rawMsg.channelID;
  const channelType = rawMsg.channelType ?? 1;
  const msgId = rawMsg.messageID || 'unknown';
  const timestamp = rawMsg.timestamp || Date.now() / 1000;

  // 根据 contentType 提取内容
  let content = '';
  let contentObj = rawMsg.content;
  // 如果 content 是 { contentObj: { url, name, size, type } } 结构，提取出来
  if (rawMsg.content?.contentObj) {
    contentObj = rawMsg.content.contentObj;
  }
  const contentType = rawMsg.contentType ?? 1;

  // 检测是否是文件（有 name, url, size 字段的对象）
  const isFileObject = contentObj?.name && contentObj?.url;

  if (contentType === 4 || isFileObject) {
    // 文件消息：统一提取 name, url, size, type 用于图形化显示
    content = JSON.stringify({
      name: contentObj?.name || contentObj?.fileName || '',
      url: contentObj?.url || '',
      size: contentObj?.size || 0,
      type: contentObj?.type || ''
    });
  } else if (contentType === 1) {
    // 文本消息 - 支持 text 和 content 字段
    content = contentObj?.text || contentObj?.content || '';
  } else if (contentType === 2) {
    // 图片消息
    content = contentObj?.url || rawMsg.content?.url || '';
  } else if (contentType === 3) {
    // 视频消息
    content = contentObj?.url || '[视频]';
  } else {
    // 其他类型，尝试提取有意义的字段
    const c = rawMsg.content;
    if (typeof c === 'object' && c !== null) {
      content = c.fileName || c.url || c.text || JSON.stringify(c);
    } else {
      content = String(c || '');
    }
  }
  // 确保 content 是字符串
  if (typeof content !== 'string') {
    content = JSON.stringify(content);
  }

  safeSend({
    type: 'message',
    agentId,
    data: {
      fromUid,
      toUid,
      channelId,
      channelType,
      content: typeof content === 'string' ? content : String(content),
      contentType,
      messageId: msgId,
      timestamp,
      messageSeq: rawMsg.messageSeq,
      clientMsgNo: rawMsg.clientMsgNo,
      noPersist: rawMsg.header?.noPersist ? 1 : 0,
      redDot: rawMsg.header?.reddot ? 1 : 0,
      syncOnce: rawMsg.header?.syncOnce ? 1 : 0,
      mention: rawMsg.content?.mention || null
    }
  });
});

// 连接
try {
  sdk.connect();
} catch (err) {
  workerErr(`[${agentId}] sdk.connect() 失败:`, errorMessage(err), err instanceof Error ? err.stack : undefined);
  process.exit(1);
}

// SDK bug: connectManager 连接成功时不触发 notifyConnectStatusListeners(1)
// 持续轮询 SDK 内部状态，状态变化时实时上报给主进程
// 不设超时：SDK autoReconnect 自动重连后仍能检测到
let lastStatus = -1;
const connCheckTimer = setInterval(() => {
  const st = sdk.connectManager.status;
  if (st === lastStatus) return; // 状态未变，跳过
  lastStatus = st;

  if (st === 1) { // ConnectStatus.Connected
    workerLog(`[${agentId}] 连接状态: connected`);
    safeSend({ type: 'status', agentId, status: 'connected', statusCode: 1 });
  } else if (st === 0) { // Disconnect
    workerLog(`[${agentId}] 连接状态: disconnected`);
    safeSend({ type: 'status', agentId, status: 'disconnected', statusCode: 0 });
  } else if (st === 3) { // ConnectFail
    workerLog(`[${agentId}] 连接状态: connect_fail`);
    safeSend({ type: 'status', agentId, status: 'connect_fail', statusCode: 3 });
  } else if (st === 4) { // ConnectKick — SDK 不会自动重连，停止轮询
    workerLog(`[${agentId}] 连接状态: kicked`);
    safeSend({ type: 'status', agentId, status: 'kicked', statusCode: 4 });
    clearInterval(connCheckTimer);
  }
}, 500);

// 等待服务端回执的发送队列（clientSeq → 消息元数据）
const pendingSends = new Map<number, PendingSend>();

// 监听发送回执（服务端确认后提供真实 messageSeq）
sdk.chatManager.addMessageStatusListener((sendack: DynamicSdkValue) => {
  const pending = pendingSends.get(sendack.clientSeq);
  if (pending) {
    safeSend({
      type: 'sent',
      agentId: pending.agentId,
      channelId: pending.channelId,
      localMsgId: pending.localMsgId,
      messageId: sendack.messageID,
      messageSeq: sendack.messageSeq,
      clientMsgNo: pending.clientMsgNo,
      success: true
    });
    pendingSends.delete(sendack.clientSeq);
  }
});

// 接收主进程指令（兼容新旧双格式：旧 type=send/disconnect/ping；新 type=req method=worker.*）
let shuttingDown = false;
function shutdownWorker(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  workerLog(`[${agentId}] worker 正在退出: ${reason}`);
  try { sdk.disconnect(); } catch {}
  setImmediate(() => process.exit(0));
}

process.on('message', (_msg: unknown) => {
  if (!_msg || typeof _msg !== 'object') return;
  const request = _msg as LegacyWorkerRequest | RpcWorkerRequest;
  if (request.type === 'req') {
    const m = request.method, p = request.params || {};
    console.log(`[${agentId}] 收到 req: ${m}`);
    if (m === 'worker.send' && p.channelId) { _execSend(p.channelId, p.content || '', p.messageType, p.localMsgId, p.channelType, p.mentions); }
    else if (m === 'worker.disconnect') { shutdownWorker('worker.disconnect'); }
    else if (m === 'worker.ping') { safeSend({ type: 'pong', agentId, connected: sdk.connectManager.status === 1, statusCode: sdk.connectManager.status }); }
    return;
  }

  const msg = request as LegacyWorkerRequest;
  if (msg && msg.type === 'ping') {
    const st = sdk.connectManager.status;
    safeSend({ type: 'pong', agentId, connected: st === 1, statusCode: st });
    return;
  }
  console.log(`[${agentId}] 收到指令:`, JSON.stringify(msg).substring(0, 100));

  if (msg.type === 'send' && msg.channelId) {
    _execSend(msg.channelId, msg.content || '', msg.messageType, msg.localMsgId, msg.channelType, msg.mentions);
    return;
  }

  if (msg.type === 'disconnect') {
    shutdownWorker('disconnect');
  }
});

process.on('disconnect', () => shutdownWorker('ipc-disconnect'));

/** 统一发送逻辑（新旧格式共用） */
async function _execSend(
  channelId: string,
  content = '',
  messageType?: string,
  localMsgId?: string,
  channelType?: number,
  mentions?: Mention | null
): Promise<void> {
  try {
    const chType = (channelType === 2 && ChannelTypeGroup) ? ChannelTypeGroup : ChannelTypePerson;
    const channel = new Channel(channelId, chType);
    let message;
    if (messageType === 'image') {
      message = new MessageImage();
      message.url = content;
    } else if (messageType === 'file') {
      if (MessageFile) {
        let filePayload: FilePayload = {};
        try { filePayload = JSON.parse(content || '{}') as FilePayload; } catch (_) {}
        message = new MessageFile();
        message.url = filePayload.url || content;
        message.name = filePayload.name || '';
        message.size = filePayload.size || 0;
        message.type = filePayload.type || '';
      } else {
        message = new MessageText(content);
      }
    } else {
      message = new MessageText(content);
    }
    // 群聊 @提及：设置 MessageContent.mention（{all, uids}）
    if (mentions && (mentions.all || (mentions.uids && mentions.uids.length > 0))) {
      try { message.mention = { all: mentions.all || false, uids: mentions.uids || [] }; } catch (_) {}
    }
    const result = await sdk.chatManager.send(message, channel);

    const clientSeq = result.clientSeq;
    const clientMsgNo = result.clientMsgNo || null;
    pendingSends.set(clientSeq, { agentId, channelId, localMsgId: localMsgId || result.messageID, clientMsgNo });

    safeSend({
      type: 'sent', agentId, channelId,
      localMsgId: localMsgId || result.messageID,
      messageId: result.messageID,
      messageSeq: null, clientMsgNo,
      success: true
    });
  } catch (e) {
    workerErr('[' + agentId + '] 消息发送失败:', e);
    safeSend({ type: 'sent', agentId, channelId, success: false, error: errorMessage(e) });
  }
}

// 进程退出时断开连接
process.on('exit', () => {
  try { sdk.disconnect(); } catch {}
});

process.on('uncaughtException', (err) => {
  workerErr(`[${agentId}] 未捕获异常:`, err.message, err.stack);
  // 退出让 worker-manager 重启；继续运行会处于未定义状态、ping 仍报存活→僵尸
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  workerErr(`[${agentId}] 未处理的 Promise 拒绝:`, reason);
});

// 定期检查父进程是否还活着（Windows 上 kill 不触发 SIGTERM，需主动检测）
if (process.platform === 'win32') {
  const parentCheck = setInterval(() => {
    try {
      // 信号 0 = 仅探测进程是否存在，不发送实际信号
      process.kill(process.ppid, 0);
    } catch (_) {
      workerLog(`[${agentId}] 主进程已退出，worker 自动终止`);
      clearInterval(parentCheck);
      shutdownWorker('parent-exited');
    }
  }, 3000);
}

workerLog(`[${agentId}] Worker 已启动，等待连接...`);
