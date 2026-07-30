/**
 * notifier.js — 新消息通知与提示音
 *
 * 纯 Node.js 模块。收到访客消息时：
 *  - 前台运行 → 只播放自定义提示音
 *  - 托盘/最小化 → 播放提示音 + 弹系统通知（通过 lite-bus 事件转发）
 *
 * Desktop 监听 bus 事件后使用 Electron Notification API 显示通知。
 */

const bus = require('./lite-bus');
const { t, getLocale } = require('./i18n');

let _mainWindow = null;
let _db = null;

// 查询 Agent 名称
function _getAgentName(agentId) {
  try {
    const row = _db.prepare('SELECT agent_name FROM agents WHERE agent_id=?').get(agentId);
    return row?.agent_name || agentId;
  } catch (_) { return agentId; }
}

// 查询访客昵称
function _getVisitorName(visitorId) {
  try {
    const row = _db.prepare('SELECT nickname FROM user_cache WHERE uid=?').get(visitorId);
    return row?.nickname || '';
  } catch (_) { return ''; }
}

/**
 * 初始化通知模块
 * @param {object} mainWindow - BrowserWindow 实例
 * @param {object} db - better-sqlite3 实例
 */
function init(mainWindow, db) {
  _mainWindow = mainWindow;
  _db = db;
  console.log('[通知] 模块初始化, mainWindow=' + (mainWindow ? '✅ 已创建' : '❌ null'));
}

/**
 * 处理访客新消息通知
 * @param {string} agentId
 * @param {string} visitorId
 * @param {string} content
 * @param {number} timestamp
 */
function notifyNewMessage(agentId, visitorId, content, timestamp) {
  try {
    const agentName = _getAgentName(agentId);
    const visitorName = _getVisitorName(visitorId);
    const locale = getLocale();
    const time = timestamp
      ? new Date(timestamp * 1000).toLocaleTimeString(locale === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '';
    const sender = visitorName || visitorId;
    const msgContent = (content || '').substring(0, 60);
    const body = t('errors.notify.sender', {}, locale) + sender + '\n' + t('errors.notify.content', {}, locale) + msgContent + (time ? '  ' + time : '');

    // 只发事件，弹框/声音由 Desktop 的 _showNotif 处理（声音归 UI 层）
    bus.emit('voko:notification', { title: t('errors.notify.recipient', {}, locale) + agentName, body, agentId, visitorId, timestamp });
  } catch (_) {}
}

module.exports = { init, notifyNewMessage };
