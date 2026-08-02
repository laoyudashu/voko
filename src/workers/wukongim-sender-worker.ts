type SenderConfig = {
  uid: string;
  token: string;
  serverUrl: string;
};

type SendRequest = {
  agentId: string;
  uid?: string;
  channelId: string;
  content: string;
  messageType?: string;
  channelType?: number;
  mentions?: { all?: boolean; uids?: string[] } | null;
};

type SendResult = {
  success: boolean;
  messageId?: string;
  clientMsgNo?: string | null;
  messageSeq?: number | null;
  error?: string;
};

type SenderRuntimeOptions = {
  sdkModule: any;
  MessageFile: new () => any;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  onIdle?: () => void | Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSenderRuntime(options: SenderRuntimeOptions) {
  const {
    sdkModule,
    MessageFile,
    connectTimeoutMs = 10_000,
    idleTimeoutMs = 60_000,
    onIdle,
  } = options;
  const {
    WKSDK,
    MessageText,
    MessageImage,
    Channel,
    ChannelTypePerson,
    ChannelTypeGroup,
  } = sdkModule;

  let identity: { agentId: string; uid: string } | null = null;
  let sdk: any = null;
  let connectPromise: Promise<boolean> | null = null;
  let sendQueue: Promise<unknown> = Promise.resolve();
  let idleTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleExit() {
    clearIdleTimer();
    if (idleTimeoutMs <= 0 || shuttingDown) return;
    idleTimer = setTimeout(() => {
      Promise.resolve(onIdle?.()).catch(() => undefined);
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  function init(agentId: string, config: SenderConfig): SendResult {
    if (!agentId || !config?.uid || !config?.token || !config?.serverUrl) {
      return { success: false, error: 'Invalid WuKongIM sender configuration' };
    }
    if (identity) {
      if (identity.agentId !== agentId || identity.uid !== config.uid) {
        return { success: false, error: 'Sender identity is immutable' };
      }
      return { success: true };
    }

    identity = { agentId, uid: config.uid };
    sdk = WKSDK.shared();
    sdk.config.uid = config.uid;
    sdk.config.token = config.token;
    sdk.config.addr = config.serverUrl;
    sdk.config.autoReconnect = false;
    try {
      sdk.messageContentManager.register(8, MessageFile);
    } catch {
      // Re-registering the same content type is harmless for this isolated process.
    }
    scheduleIdleExit();
    return { success: true };
  }

  async function ensureConnected(): Promise<boolean> {
    if (!sdk) return false;
    if (sdk.connectManager.status === 1) return true;
    if (connectPromise) return connectPromise;

    connectPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sdk.connectManager.removeConnectStatusListener?.(listener);
        resolve(connected);
      };
      const listener = (status: number) => {
        if (status === 1) finish(true);
        if (status === 0 || status === 3 || status === 4) finish(false);
      };
      const timer = setTimeout(() => finish(false), connectTimeoutMs);
      sdk.connectManager.addConnectStatusListener(listener);
      try {
        sdk.connect();
      } catch {
        finish(false);
      }
    }).finally(() => {
      connectPromise = null;
    });

    return connectPromise;
  }

  function createMessage(content: string, messageType: string) {
    if (messageType === 'image') {
      const image = new MessageImage();
      image.url = content;
      return image;
    }
    if (messageType === 'file') {
      let file: { url?: string; name?: string; size?: number; type?: string };
      try {
        file = JSON.parse(content);
      } catch {
        file = { url: content };
      }
      const message = new MessageFile();
      message.url = file.url || content;
      message.name = file.name || '';
      message.size = file.size || 0;
      message.type = file.type || '';
      return message;
    }
    return new MessageText(content);
  }

  async function sendNow(request: SendRequest): Promise<SendResult> {
    if (!identity || !sdk) return { success: false, error: 'Sender is not initialized' };
    if (
      request.agentId !== identity.agentId
      || (request.uid !== undefined && request.uid !== identity.uid)
    ) {
      return { success: false, error: 'Sender identity mismatch' };
    }

    const connected = await ensureConnected();
    if (!connected) {
      try { sdk.disconnect(); } catch {}
      return { success: false, error: '无法连接 wukongIM，请检查 Agent 配置' };
    }

    try {
      const channelType = request.channelType === 2 && ChannelTypeGroup
        ? ChannelTypeGroup
        : ChannelTypePerson;
      const message = createMessage(request.content, request.messageType || 'text');
      if (
        request.mentions
        && (request.mentions.all || request.mentions.uids?.length)
      ) {
        message.mention = {
          all: request.mentions.all || false,
          uids: request.mentions.uids || [],
        };
      }
      const result = await sdk.chatManager.send(
        message,
        new Channel(request.channelId, channelType),
      );
      return {
        success: true,
        messageId: result?.messageID,
        clientMsgNo: result?.clientMsgNo || null,
        messageSeq: result?.messageSeq || null,
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  function send(request: SendRequest): Promise<SendResult> {
    clearIdleTimer();
    const operation = sendQueue.then(() => sendNow(request));
    sendQueue = operation.catch(() => undefined);
    return operation.finally(scheduleIdleExit);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearIdleTimer();
    await sendQueue.catch(() => undefined);
    try {
      sdk?.disconnect?.();
    } catch {
      // Closing is best effort; the process is exiting immediately afterwards.
    }
  }

  return { init, send, shutdown };
}

function runSenderProcess() {
  // The singleton SDK is intentionally loaded only inside this single-identity process.
  if (typeof WebSocket === 'undefined') {
    try {
      (globalThis as { WebSocket?: unknown }).WebSocket = require('ws');
    } catch {
      // The SDK will return its normal connection failure if no WebSocket is available.
    }
  }
  const sdkModule = require('wukongimjssdk');
  const { MessageFile } = require('./message-content');
  const runtime = createSenderRuntime({
    sdkModule,
    MessageFile,
    onIdle: async () => {
      await runtime.shutdown();
      process.exit(0);
    },
  });

  process.on('message', (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'init') {
      const result = runtime.init(message.agentId, message.config);
      process.send?.({
        type: 'ready',
        agentId: message.agentId,
        uid: message.config?.uid,
        ...result,
      });
      return;
    }
    if (message.type === 'send') {
      runtime.send(message).then((result) => {
        process.send?.({ type: 'result', requestId: message.requestId, result });
      });
      return;
    }
    if (message.type === 'shutdown') {
      runtime.shutdown().finally(() => process.exit(0));
    }
  });

  process.on('disconnect', () => {
    runtime.shutdown().finally(() => process.exit(0));
  });
}

if (require.main === module) runSenderProcess();

module.exports = { createSenderRuntime, runSenderProcess };
