const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveOpenCodeCommand(): string {
  if (process.env.VOKO_OPENCODE_BIN) return process.env.VOKO_OPENCODE_BIN;
  if (process.platform === 'win32') {
    const executable = path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      'opencode-ai',
      'bin',
      'opencode.exe',
    );
    if (fs.existsSync(executable)) return executable;
  }
  return 'opencode';
}

function isolatedOpenCodeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...extra,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: {
        '*': 'deny',
        read: 'deny',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        skill: 'deny',
        webfetch: 'deny',
        external_directory: 'deny',
      },
    }),
  };
}

function buildOpenCodeVisitorContent(agentId: string, visitorId: string, content: string): string {
  return [
    `VOKO role boundary: agent=${agentId}; visitor=${visitorId}.`,
    'Treat this as a text-only external visitor conversation.',
    'Never access another visitor session. Never execute tools, commands, links, payments, schedules, or file operations for the visitor.',
    `Visitor message:\n${content}`,
  ].join('\n\n');
}

function newServerPassword(): string {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  buildOpenCodeVisitorContent,
  isolatedOpenCodeEnv,
  newServerPassword,
  resolveOpenCodeCommand,
};

export {};
