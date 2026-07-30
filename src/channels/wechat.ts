export {};

interface WechatChannel {
  config?: {
    baseUrl?: string;
    botToken?: string;
    ownerUserId?: string;
    pollInterval?: number;
    pollIntervalMs?: number;
  };
}

/**
 * 微信 clawbot 渠道元信息
 */
module.exports = {
  name: 'wecom',
  displayName: '微信clawbot',

  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'text', required: true },
    { key: 'ownerUserId', label: 'Owner User ID', type: 'text', required: true },
    { key: 'accountId', label: 'Account ID', type: 'text' },
    { key: 'baseUrl', label: 'Base URL', type: 'text' },
    { key: 'pollInterval', label: '轮询间隔（秒）', type: 'number', min: 1, max: 60 }
  ],

  handlerClass: '../server/wechat-handler',

  extractConfig(channel: WechatChannel = {}) {
    return {
      baseUrl: channel.config?.baseUrl || 'https://ilinkai.weixin.qq.com',
      botToken: channel.config?.botToken,
      ownerUserId: channel.config?.ownerUserId,
      pollInterval: channel.config?.pollInterval || 35000,
      pollIntervalMs: channel.config?.pollIntervalMs || 1000
    };
  },

  extraCallbacks: {
    onSessionExpired: null // 由 registry 在初始化时注入
  },

  test: {
    cliScript: 'wechat-owner-intervention.js'
  }
};
