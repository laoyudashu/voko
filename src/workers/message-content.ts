export {};

/**
 * 自定义 IM 消息内容类
 *
 * WuKongIM JS SDK 内置：MessageText(1)、MessageImage(2)、MessageVideo(3) 等。
 * 文件消息（contentType=4）没有现成类，因此参考 chatroom 项目实现自定义 MessageFile。
 */

const { MessageContent } = require('wukongimjssdk');

// WuKongIM SDK 当前版本未导出 file 常量，文件消息统一使用 contentType = 4
const MESSAGE_CONTENT_TYPE_FILE = 4;

interface FileMessageJson {
  url?: string;
  name?: string;
  size?: number;
  type?: string;
}

/**
 * 文件消息内容类
 * encodeJSON / decodeJSON 会被 SDK 用于序列化/反序列化 payload
 */
class MessageFile extends MessageContent {
  constructor() {
    super();
    this.url = '';
    this.name = '';
    this.size = 0;
    this.type = '';
  }

  get contentType() {
    return MESSAGE_CONTENT_TYPE_FILE;
  }

  encodeJSON() {
    return {
      url: this.url,
      name: this.name,
      size: this.size,
      type: this.type
    };
  }

  decodeJSON(json: FileMessageJson): void {
    this.url = json.url || '';
    this.name = json.name || '';
    this.size = json.size || 0;
    this.type = json.type || '';
  }

  get conversationDigest() {
    return `[文件] ${this.name || ''}`;
  }
}

module.exports = { MessageFile };
