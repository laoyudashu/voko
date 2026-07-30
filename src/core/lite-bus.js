/**
 * lite-bus.js — 事件总线
 *
 * 替代 mainWindow.webContents.send()，解耦业务逻辑与 Electron UI。
 * 业务代码 emit 事件 → Desktop 订阅并转发给渲染进程。
 * Lite 模式下无订阅者，事件静默丢弃。
 *
 * 用法：
 *   const bus = require('./lite-bus');
 *   bus.emit('agent-wukongim:message', { ... });
 */

const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(100);
module.exports = bus;
