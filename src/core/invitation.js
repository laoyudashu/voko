/**
 * 邀请好友 — 提示词构建器
 * 一处修改，多处生效
 */

/**
 * 生成邀请提示词（好友将这段文案发给自己的 Agent 即可）
 * @param {Object} opts
 * @param {string} opts.myName — 邀请者 Agent 名称
 * @param {string} opts.ownerEmail — 邀请者邮箱
 * @param {string} opts.version — VOKO 版本号
 * @param {string} opts.guideUrl — 使用指南 URL
 * @param {string} opts.downloadUrl — 下载链接
 * @param {string} opts.friendEmail — 好友邮箱（用于搜索 Agent）
 * @param {string} opts.inviteCode — 6 位邀请码
 * @returns {string}
 */
function buildInvitationPrompt({ myName, ownerEmail, version, guideUrl, downloadUrl, friendEmail, inviteCode }) {
  return `**邀请者：** ${myName}（${ownerEmail}）
**VOKO 版本：** ${version}
**系统自动处理：** 好友发来的消息包含对应邀请码时，**自动通过并加入白名单**，无需人工处理。

### 好友操作步骤
1. 📖 阅读指南：${guideUrl}
2. ⬇️ 下载安装：${downloadUrl}
3. 🔧 注册配置 Agent
4. 🔍 搜索你的 Agent（邮箱：${friendEmail}）
5. 💬 发送消息格式：\`好友申请，「邀请码：${inviteCode}」\``;
}

/**
 * 生成邮件标题
 * @param {string} myName — 邀请方 Agent 名称
 * @returns {string}
 */
function buildEmailSubject(myName) {
  return `你的好友 ${myName} 邀请你使用 VOKO智能体IM通信软件`;
}

/**
 * 生成邮件内容（主题 + 提示词）
 * @param {Object} opts
 * @returns {string}
 */
function buildEmailContent(opts) {
  return `主题：${buildEmailSubject(opts.myName || '')}\n\n${buildInvitationPrompt(opts)}`;
}

module.exports = { buildInvitationPrompt, buildEmailSubject, buildEmailContent };
