export {};

const { spawn } = require('child_process');

/**
 * OpenClaw CLI 消息处理器
 * 使用 CLI 命令调用 OpenClaw，无需 Gateway HTTP 配置
 */
class OpenClawCLIHandler {
  [key: string]: any;
  constructor(database?: any, mainWindow?: any) {
    this.db = database;
    this.mainWindow = mainWindow;
    this.enabled = false;
    this.processingChannels = new Set();
    this.agentName = 'main'; // 默认使用 main agent，可改成 voko
  }

  setEnabled(enabled?: any) {
    this.enabled = enabled;
    console.log('[OpenClaw CLI] 自动回复:', enabled ? '已启用' : '已禁用');
  }

  // 调用 OpenClaw CLI 命令
  callOpenClawCLI(messageContent?: any) {
    return new Promise((resolve?: any, reject?: any) => {
      const prompt = `你是 VOKO IM 智能助手。用户发来消息："${messageContent}"

请生成友好、专业的回复（100字以内）。只输出回复内容，不要有任何前缀或解释。`;

      console.log('[OpenClaw CLI] 执行命令...');

      const child = spawn('openclaw', [
        'run',
        '--agent', this.agentName,
        '--message', prompt
      ], {
        timeout: 60000, // 60秒超时
        windowsHide: true // 隐藏命令行窗口
      });

      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data?: any) => {
        output += data.toString();
        console.log('[OpenClaw CLI stdout]:', data.toString().substring(0, 100));
      });

      child.stderr.on('data', (data?: any) => {
        errorOutput += data.toString();
        console.log('[OpenClaw CLI stderr]:', data.toString().substring(0, 100));
      });

      child.on('close', (code?: any) => {
        console.log(`[OpenClaw CLI] 进程退出码: ${code}`);
        if (code === 0) {
          resolve(output.trim() || '收到你的消息');
        } else {
          reject(new Error(`CLI 失败，退出码: ${code}, 错误: ${errorOutput}`));
        }
      });

      child.on('error', (err?: any) => {
        console.error('[OpenClaw CLI] 启动失败:', err.message);
        if (err.code === 'ENOENT') {
          reject(new Error('找不到 openclaw 命令，请检查 PATH 或安装 OpenClaw'));
        } else {
          reject(err);
        }
      });
    });
  }
}

module.exports = OpenClawCLIHandler;
