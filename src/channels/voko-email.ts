export {};

module.exports = {
  name: 'voko-email',
  displayName: 'VOKO 邮件',
  configFields: [],
  handlerClass: '../server/voko-email-handler',
  extractConfig: (_channel?: unknown) => ({}),
};
