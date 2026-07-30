/**
 * LLM Client - 支持自动检测(OpenClaw)和手动配置两种模式
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getHermesDir, getHermesProfilesDir, getHermesEnvPath, getHermesConfigPath } = require('./hermes-paths');
const http = require('http');
const { execSync, spawnSync } = require('child_process');
const { assertSecureEndpoint } = require('./url-security');

// 模型名称 → 真实 API 端点映射表
const MODEL_ENDPOINT_PRESETS = [
  { match: /deepseek/i, baseUrl: 'https://api.deepseek.com' },
  { match: /moonshot|kimi/i, baseUrl: 'https://api.moonshot.cn/v1' },
  { match: /glm|zhipu|chatglm/i, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  { match: /qwen|dashscope|tongyi/i, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { match: /stepfun|step/i, baseUrl: 'https://api.stepfun.com/step_plan/v1' },
  { match: /ark|volces/i, baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
  { match: /modelscope/i, baseUrl: 'https://api-inference.modelscope.cn/v1' },
  { match: /baidu|qianfan/i, baseUrl: 'https://qianfan.baidubce.com/v2/coding' },
];

/**
 * OpenClaw 路由别名 → 真实 API 模型名映射
 * OpenClaw 配置中的 model.primary 可能是 provider/model 格式的路由别名，
 * 需要映射为 API 真实接受的模型名。
 */
const ROUTING_ALIAS_MAP = {
  'deepseek/deepseek-chat': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
};

/**
 * 从 openclaw.json 读取 gateway 端口，不存在则返回默认 18789
 */
function getOpenclawPort() {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.gateway?.port) return config.gateway.port;
    }
  } catch (_) { /* ignore */ }
  return 18789;
}

/** 判断端点是否为本地地址（localhost / 127.x） */
function isLocalEndpoint(url) {
  if (!url) return true;
  try {
    const hostname = typeof url === 'string' ? url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0] : '';
    return !hostname || hostname === 'localhost' || hostname.startsWith('127.') || hostname === '0.0.0.0' || hostname === '::1';
  } catch (_) { return true; }
}

/** 根据模型名称匹配预设端点 */
function resolveEndpoint(modelName, configEndpoint) {
  // 如果配置文件提供了真实端点（非本地地址），优先使用
  if (configEndpoint && !isLocalEndpoint(configEndpoint)) {
    let normalized = configEndpoint.replace(/\/+$/, '');
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = 'https://' + normalized;
    }
    return normalized;
  }
  // 否则匹配预设表
  if (modelName) {
    for (const preset of MODEL_ENDPOINT_PRESETS) {
      if (preset.match.test(modelName)) return preset.baseUrl;
    }
  }
  // 都不匹配则返回 null
  return null;
}

class LLMClient {
  constructor(configPath) {
    this.configPath = configPath || this.getDefaultConfigPath();
    this.config = this.loadConfig();
  }

  getDefaultConfigPath() {
    const userDataPath = process.env.APPDATA || process.env.HOME || os.homedir();
    return path.join(userDataPath, 'llm-config.json');
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        return config;
      }
    } catch (e) {
      console.error('[LLM] 加载配置失败:', e.message);
    }
    return this.getDefaultConfig();
  }

  getDefaultConfig() {
    return {
      mode: 'auto', // 'auto' | 'manual'
      providers: [],
      activeProviderId: null
    };
  }

  /**
   * 检测 OpenClaw 本地代理
   * 首先尝试 HTTP 检测，如果失败则从配置文件读取
   */
  async detectOpenClawProxy() {
    // 先尝试 HTTP 检测（如果 OpenClaw 正在运行）
    const httpResult = await this._detectViaHttp();
    if (httpResult.detected) {
      return httpResult;
    }

    // 如果 HTTP 检测失败，尝试从配置文件读取
    const configResult = this._detectViaConfigFile();
    if (configResult.detected) {
      return configResult;
    }

    return {
      detected: false,
      error: 'OpenClaw 未运行或配置未找到'
    };
  }

  /**
   * 通过 HTTP API 检测 OpenClaw
   */
  _detectViaHttp() {
    return new Promise((resolve) => {
      const ocPort = getOpenclawPort();
      const options = {
        hostname: '127.0.0.1',
        port: ocPort,
        path: '/coding/v1/models',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer proxy-managed'
        },
        timeout: 3000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const models = JSON.parse(data);
              const modelList = models.data || [];
              const firstModel = modelList[0];

              if (firstModel) {
                resolve({
                  detected: true,
                  provider: {
                    id: 'openclaw-kimi',
                    name: `OpenClaw / ${firstModel.id}`,
                    baseUrl: `http://127.0.0.1:${getOpenclawPort()}/coding`,
                    apiKey: 'proxy-managed',
                    modelId: firstModel.id,
                    apiType: 'anthropic-messages'
                  }
                });
                return;
              }
            } catch (e) {
              console.error('[LLM] 解析 models 响应失败:', e);
            }
          }
          resolve({ detected: false, error: '无法获取模型列表' });
        });
      });

      req.on('error', (err) => {
        console.log('[LLM] OpenClaw 检测失败:', err.message);
        resolve({ detected: false, error: 'OpenClaw 未运行或端口不通' });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ detected: false, error: '连接超时' });
      });

      req.end();
    });
  }

  /**
   * 通过 LLM_chat config.json 检测 OpenClaw 配置
   */
  _detectViaConfigFile() {
    try {
      // 尝试多个可能的 config.json 路径
      const possiblePaths = [
        // LLM_chat 项目目录
        path.join(process.cwd(), '..', 'LLM_chat', 'config.json'),
        path.join(process.cwd(), '..', '..', 'LLM_chat', 'config.json'),
        // 用户主目录下的 LLM_chat
        path.join(os.homedir(), 'LLM_chat', 'config.json'),
      ];

      let configPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          configPath = p;
          break;
        }
      }

      if (!configPath) {
        return { detected: false, error: '未找到 LLM_chat/config.json' };
      }

      console.log('[LLM] 找到 LLM_chat 配置:', configPath);
      const llmChatConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // 获取活跃的 provider
      const activeProviderId = llmChatConfig.active_provider_id;
      const providers = llmChatConfig.providers || [];

      if (!providers.length) {
        return { detected: false, error: '配置中没有 providers' };
      }

      // 找到活跃的 provider，或第一个可用的
      let provider = providers.find(p => p.id === activeProviderId && p.is_active);
      if (!provider) {
        provider = providers.find(p => p.is_active);
      }
      if (!provider) {
        provider = providers[0];
      }

      return {
        detected: true,
        provider: {
          id: 'openclaw-kimi',
          name: `OpenClaw / ${provider.name || provider.model_id}`,
          baseUrl: provider.base_url || `http://127.0.0.1:${getOpenclawPort()}/coding`,
          apiKey: provider.api_key || 'proxy-managed',
          modelId: provider.model_id,
          apiType: provider.api_type || 'anthropic-messages'
        }
      };
    } catch (e) {
      console.error('[LLM] 读取 LLM_chat 配置失败:', e.message);
      return { detected: false, error: '读取配置失败: ' + e.message };
    }
  }

  /**
   * 初始化配置（自动检测或加载已有）
   */
  async initConfig() {
    // 如果已有活跃配置，直接使用
    if (this.config.activeProviderId) {
      return { success: true, mode: this.config.mode, initialized: true };
    }

    // 自动模式：尝试检测 OpenClaw
    if (this.config.mode === 'auto') {
      const detection = await this.detectOpenClawProxy();

      if (detection.detected) {
        this.config.providers = [detection.provider];
        this.config.activeProviderId = detection.provider.id;
        this.saveConfig();

        return {
          success: true,
          mode: 'auto',
          provider: detection.provider,
          message: '已自动连接到 OpenClaw'
        };
      } else {
        return {
          success: false,
          mode: 'auto',
          error: detection.error,
          message: '自动检测失败，请切换到手动模式'
        };
      }
    }

    // 手动模式：检查是否有手动配置的 provider
    const manualProvider = this.config.providers.find(p => p.id !== 'openclaw-kimi');
    if (manualProvider) {
      this.config.activeProviderId = manualProvider.id;
      this.saveConfig();
      return {
        success: true,
        mode: 'manual',
        provider: manualProvider
      };
    }

    return {
      success: false,
      mode: this.config.mode,
      error: '未配置 LLM Provider'
    };
  }

  /**
   * 添加手动配置的 Provider
   */
  addManualProvider(config) {
    const baseUrl = assertSecureEndpoint(config.baseUrl, 'http');
    const provider = {
      id: 'manual-' + Date.now(),
      name: config.name || 'Manual / ' + config.modelId,
      baseUrl,
      apiKey: config.apiKey,
      modelId: config.modelId,
      apiType: config.apiType || 'openai'
    };

    // 移除旧的 manual provider
    this.config.providers = this.config.providers.filter(p => !p.id.startsWith('manual-'));

    this.config.providers.push(provider);
    this.config.activeProviderId = provider.id;
    this.config.mode = 'manual';

    this.saveConfig();
    return provider;
  }

  /**
   * 切换到指定 Provider
   */
  switchProvider(providerId) {
    const provider = this.config.providers.find(p => p.id === providerId);
    if (provider) {
      this.config.activeProviderId = providerId;
      this.saveConfig();
      return { success: true, provider };
    }
    return { success: false, error: 'Provider 不存在' };
  }

  /**
   * 获取当前活跃配置
   */
  getActiveProvider() {
    if (!this.config.activeProviderId) return null;
    return this.config.providers.find(p => p.id === this.config.activeProviderId);
  }

  /**
   * 获取所有配置信息
   */
  getConfig() {
    return {
      mode: this.config.mode,
      activeProviderId: this.config.activeProviderId,
      providers: this.config.providers.map(p => ({
        ...p,
        apiKey: p.apiKey ? '****' + p.apiKey.slice(-4) : ''
      })),
      isConfigured: !!this.config.activeProviderId
    };
  }

  /**
   * 保存配置
   */
  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 设置模式（auto/manual）
   */
  setMode(mode) {
    if (mode !== 'auto' && mode !== 'manual') {
      return { success: false, error: '无效模式' };
    }

    this.config.mode = mode;

    // 切换模式时重置 active provider
    if (mode === 'auto') {
      this.config.activeProviderId = null;
    }

    this.saveConfig();
    return { success: true };
  }

  /**
   * 调用 LLM API
   */
  async chat(messages, options = {}) {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('未配置 LLM Provider');
    }

    const timeout = (options.timeout || 30) * 1000;

    return new Promise((resolve, reject) => {
      const payload = this.buildPayload(provider, messages, options);
      const endpoint = this.getEndpoint(provider);

      const url = new URL(endpoint);

      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload))
      };
      if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }
      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: timeout
      };

      const client = url.protocol === 'https:' ? require('https') : http;

      const req = client.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const result = JSON.parse(data);
              const content = this.parseResponse(provider, result);
              resolve(content);
            } else {
              reject(new Error(`API ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error('解析响应失败: ' + e.message));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });

      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  /**
   * 构建请求体
   */
  buildPayload(provider, messages, options) {
    if (provider.apiType === 'anthropic-messages') {
      const payload = {
        model: provider.modelId,
        messages: messages.map(m => ({
          role: m.role === 'system' ? 'user' : m.role,
          content: m.content
        })),
        max_tokens: options.max_tokens || 4096,
        stream: false
      };

      // 提取 system 消息
      const systemMsg = messages.find(m => m.role === 'system');
      if (systemMsg) {
        payload.system = systemMsg.content;
      }

      return payload;
    } else {
      // OpenAI 格式
      return {
        model: provider.modelId,
        messages: messages,
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 2000,
        stream: false
      };
    }
  }

  /**
   * 获取 API 端点
   */
  getEndpoint(provider) {
    const baseUrl = assertSecureEndpoint(provider.baseUrl, 'http').replace(/\/$/, '');

    if (provider.apiType === 'anthropic-messages') {
      return `${baseUrl}/v1/messages`;
    } else {
      return `${baseUrl}/v1/chat/completions`;
    }
  }

  /**
   * 解析响应
   */
  parseResponse(provider, data) {
    if (provider.apiType === 'anthropic-messages') {
      const content = data.content || [];
      if (content.length > 0) {
        return content[0].text || '';
      }
    } else {
      const choices = data.choices || [];
      if (choices.length > 0) {
        return choices[0].message?.content || '';
      }
    }
    return '';
  }

  /**
   * 带重试的调用
   */
  async chatWithRetry(messages, maxRetries = 2, options = {}) {
    let lastError;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const content = await this.chat(messages, options);
        return { success: true, content };
      } catch (err) {
        lastError = err.message;
        console.error(`[LLM] 调用失败 (${i + 1}/${maxRetries + 1}):`, err.message);

        if (i < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }

    return { success: false, error: lastError };
  }

  /**
   * 测试连接
   */
  async testConnection() {
    try {
      const messages = [{ role: 'user', content: '你好，请回复"连接成功"' }];
      const result = await this.chatWithRetry(messages, 0);
      return {
        success: result.success,
        message: result.success ? '连接成功' : result.error,
        response: result.success ? result.content?.substring(0, 100) : null
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  /**
   * 设置活跃 Provider（外部授权或配置导入后调用）
   */
  setActiveProvider(provider) {
    this.config.providers = [provider];
    this.config.activeProviderId = provider.id;
    this.config.mode = 'manual';
    this.saveConfig();
    return { success: true };
  }

  /**
   * 测试指定 provider 的连接（不改变当前活跃 provider）
   */
  async testProvider(provider) {
    const prevId = this.config.activeProviderId;
    const prevProviders = [...this.config.providers];

    try {
      // 临时切换
      this.config.providers = [provider];
      this.config.activeProviderId = provider.id;

      const result = await this.chatWithRetry(
        [{ role: 'user', content: '你好，请回复"连接成功"（回复不要超过10个字）' }],
        1
      );

      return {
        success: result.success,
        message: result.success ? '连接成功' : result.error,
        response: result.success ? result.content?.substring(0, 100) : null
      };
    } catch (e) {
      return { success: false, message: e.message };
    } finally {
      // 恢复原 provider
      this.config.providers = prevProviders;
      this.config.activeProviderId = prevId;
      this.saveConfig();
    }
  }

  /**
   * 从所有可用的本地来源发现 LLM Provider
   * 返回 [{ id, name, baseUrl, apiKey, modelId, apiType, source, sourceLabel }]
   */
  async discoverAllModels() {
    const providers = [];
    const seenIds = new Set();

    // Source 1: OpenClaw HTTP 代理（端口 18789）
    try {
      const httpResult = await this._detectViaHttp();
      if (httpResult.detected && httpResult.provider) {
        const p = { ...httpResult.provider, source: 'openclaw-proxy', sourceLabel: 'OpenClaw 运行中' };
        if (!seenIds.has(p.id)) {
          providers.push(p);
          seenIds.add(p.id);
        }
      }
    } catch (e) { /* ignore */ }

    // Source 2: LLM_chat config.json
    try {
      const configResult = this._detectViaConfigFile();
      if (configResult.detected && configResult.provider) {
        const p = { ...configResult.provider, source: 'llm-chat', sourceLabel: 'LLM_chat 配置' };
        if (!seenIds.has(p.id)) {
          providers.push(p);
          seenIds.add(p.id);
        }
      }
    } catch (e) { /* ignore */ }

    // Source 3: OpenClaw openclaw.json
    try {
      const ocResult = this._detectViaOpenclawJson();
      if (ocResult.detected && ocResult.provider) {
        const p = { ...ocResult.provider, source: 'openclaw-config', sourceLabel: 'OpenClaw 配置' };
        if (!seenIds.has(p.id)) {
          providers.push(p);
          seenIds.add(p.id);
        }
      }
    } catch (e) { /* ignore */ }

    // Source 4: Hermes profiles
    try {
      const hermesResult = this._detectViaHermes();
      if (hermesResult.detected && hermesResult.providers) {
        for (const p of hermesResult.providers) {
          if (!seenIds.has(p.id)) {
            providers.push(p);
            seenIds.add(p.id);
          }
        }
      }
    } catch (e) { /* ignore */ }

    return providers;
  }

  /**
   * 发现唯一模型列表（按 modelId 去重，聚合来源信息）
   * 返回 [{ modelId, sources: [...], providers: [...] }]
   */
  async discoverUniqueModels() {
    const providers = await this.discoverAllModels();
    const modelMap = new Map();

    for (const p of providers) {
      const key = p.modelId || 'unknown';
      if (!modelMap.has(key)) {
        modelMap.set(key, {
          modelId: key,
          modelName: p.modelId || '未知模型',
          displayName: p.name || p.modelId || '未知模型',
          sources: [],
          providers: []
        });
      }
      const entry = modelMap.get(key);
      if (!entry.sources.includes(p.sourceLabel || p.source)) {
        entry.sources.push(p.sourceLabel || p.source);
      }
      entry.providers.push(p);
    }

    return Array.from(modelMap.values());
  }

  /**
   * 从 openclaw.json 的任意层级搜索 api_key 相关字段
   */
  _extractKeyFromObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    const keyPatterns = ['api_key', 'apiKey', 'apikey', 'API_KEY', 'apikey', 'secret_key', 'secret'];
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      if (keyPatterns.some(p => kl.includes(p.toLowerCase())) && typeof v === 'string' && v.length > 8) {
        return v;
      }
      if (typeof v === 'object') {
        const found = this._extractKeyFromObject(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * 读取 Hermes profile config.yaml 中的配置（简易 key-value 解析）
   */
  _parseHermesConfig(yamlContent) {
    const result = {};
    for (const line of yamlContent.split('\n')) {
      const match = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*?)\s*$/);
      if (match) {
        result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    }
    return result;
  }

  /**
   * 读取 ~/.hermes/.env 中的环境变量（共享方法，供多个检测路径使用）
   */
  _readHermesEnv() {
    const envPath = getHermesEnvPath();
    const envVars = {};
    try {
      if (fs.existsSync(envPath)) {
        const raw = fs.readFileSync(envPath, 'utf-8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx === -1) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          envVars[key] = val.replace(/^["']|["']$/g, '');
        }
      }
    } catch (_) { /* ignore */ }
    return envVars;
  }

  /**
   * 通过 openclaw.json 检测模型配置（含 API Key 提取）
   */
  _detectViaOpenclawJson() {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return { detected: false };

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      let modelName = null;

      // 尝试多个位置获取模型名称
      if (config.agents?.defaults?.model?.primary) modelName = config.agents.defaults.model.primary;
      else if (config.agents?.defaultModel) modelName = config.agents.defaultModel;
      else if (config.gateway?.model) modelName = config.gateway.model;

      // 也检查 auth.profiles 中的模型
      if (!modelName) {
        const profiles = config.auth?.profiles || {};
        for (const key of Object.keys(profiles)) {
          const profile = profiles[key];
          if (profile.model?.primary) { modelName = profile.model.primary; break; }
          if (profile.model) { modelName = profile.model; break; }
        }
      }

      if (!modelName) return { detected: false };

      // 尝试从 openclaw.json 中提取 API Key（独立 try-catch，不影响模型检测）
      let apiKey = null;
      try {
        apiKey = this._extractKeyFromObject(config);
      } catch (_) { /* ignore */ }
      if (!apiKey) {
        // 尝试从 ~/.hermes/.env 中读取（最可能存 Key 的地方）
        const envVars = this._readHermesEnv();
        const nameLower = modelName.toLowerCase();
        if (nameLower.includes('deepseek')) {
          apiKey = envVars.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || null;
        } else if (nameLower.includes('claude') || nameLower.includes('anthropic')) {
          apiKey = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null;
        } else {
          apiKey = envVars.OPENAI_API_KEY || process.env.OPENAI_API_KEY || null;
        }
        // 最终保底
        if (!apiKey) {
          apiKey = envVars.DEEPSEEK_API_KEY || envVars.ANTHROPIC_API_KEY || envVars.OPENAI_API_KEY
            || process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
            || null;
        }
      }

      // 确定 apiType: 如果模型名包含 claude/anthropic 则用 anthropic-messages，否则 openai
      const nameLower = modelName.toLowerCase();
      const apiType = (nameLower.includes('claude') || nameLower.includes('anthropic'))
        ? 'anthropic-messages' : 'openai';

      // 端点: 从配置中提取真实地址（排除 localhost）
      let configEndpoint = null;
      try {
        JSON.parse(fs.readFileSync(configPath, 'utf-8'), (k, v) => {
          if (typeof v === 'string' && !configEndpoint) {
            const kl = k.toLowerCase();
            if ((kl.includes('url') || kl.includes('endpoint') || kl.includes('end_point') || kl.includes('base_url')) && v.length > 5) {
              configEndpoint = v;
            }
          }
          return v;
        });
      } catch (_) { /* ignore */ }
      const baseUrl = resolveEndpoint(modelName, configEndpoint) || `http://127.0.0.1:${getOpenclawPort()}/coding`;

      return {
        detected: true,
        provider: {
          id: 'openclaw-' + modelName.replace(/[^a-zA-Z0-9]/g, '-'),
          name: `OpenClaw / ${modelName}`,
          baseUrl,
          apiKey: apiKey || 'proxy-managed',
          modelId: ROUTING_ALIAS_MAP[modelName] || modelName,
          apiType
        }
      };
    } catch (e) {
      return { detected: false };
    }
  }

  /**
   * 通过 Hermes profiles 检测模型配置（含 API Key 提取）
   */
  _detectViaHermes() {
    const profiles = [];

    // 方案1: hermes profile list CLI（用 spawnSync 避免 Windows cmd.exe 乱码）
    try {
      const result = spawnSync('hermes', ['profile', 'list'], {
        encoding: 'utf-8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (result.error || result.status !== 0) throw result.error || new Error('non-zero exit');
      const output = result.stdout;
      const lines = output.split('\n').filter(l => l.trim());
      let parsing = false;
      for (const line of lines) {
        if (line.includes('───')) { parsing = true; continue; }
        if (!parsing) continue;
        const trimmed = line.trim();
        if (!trimmed) continue;
        const isDefault = trimmed.startsWith('◆');
        const clean = trimmed.replace(/^◆\s*/, '');
        const parts = clean.split(/\s{2,}/).map(s => s.trim());
        if (parts.length >= 1) {
          profiles.push({
            name: parts[0],
            model: parts[1] || 'unknown',
            isDefault
          });
        }
      }
    } catch (e) {
      // CLI 不可用，尝试目录发现
    }

    // 方案2: 读取 ~/.hermes/profiles/ 目录
    const profilesDir = getHermesProfilesDir();
    if (profiles.length === 0) {
      try {
        if (fs.existsSync(profilesDir)) {
          const dirs = fs.readdirSync(profilesDir);
          for (const dir of dirs) {
            const configPath = path.join(profilesDir, dir, 'config.yaml');
            let model = 'unknown';
            if (fs.existsSync(configPath)) {
              const content = fs.readFileSync(configPath, 'utf-8');
              const match = content.match(/default:\s*(\S+)/);
              if (match) model = match[1];
            }
            profiles.push({ name: dir, model, isDefault: false });
          }
        }
      } catch (e) { /* ignore */ }
    }

    // ─── 读取 ~/.hermes/.env（共享方法，用于 API Key 提取）───
    const hermesDir = getHermesDir();
    const envVars = this._readHermesEnv();

    // 方案3: 读取根目录 config.yaml（当 profiles 为空时兜底）
    const hermesConfigPath = getHermesConfigPath();
    let rootConfigModel = null;
    let rootConfigProvider = null;
    let rootConfigBaseUrl = null;
    let rootApiKey = '';

    if (profiles.length === 0) {
      try {
        if (fs.existsSync(hermesConfigPath)) {
          const content = fs.readFileSync(hermesConfigPath, 'utf-8');
          const lines = content.split('\n');

          // 定向提取 model: 块下的 default / provider / base_url
          let inModelBlock = false;
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === 'model:' || trimmed.startsWith('model:')) {
              inModelBlock = true;
              continue;
            }
            if (inModelBlock) {
              // 如果遇到非缩进的新 key，表示已离开 model 块
              if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.includes(':')) {
                inModelBlock = false;
                continue;
              }
              const subMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*?)$/);
              if (subMatch) {
                const val = subMatch[2].replace(/^["']|["']$/g, '');
                if (subMatch[1] === 'default') rootConfigModel = val;
                else if (subMatch[1] === 'provider') rootConfigProvider = val;
                else if (subMatch[1] === 'base_url') rootConfigBaseUrl = val;
              }
            }
          }

          // 从 .env 中根据 provider 类型构造 key 名（如 DEEPSEEK_API_KEY）
          if (rootConfigProvider) {
            const envKeyName = rootConfigProvider.toUpperCase() + '_API_KEY';
            if (envVars[envKeyName]) {
              rootApiKey = envVars[envKeyName];
            }
          }
          // 再从 .env 中尝试常见 key 名
          if (!rootApiKey) {
            rootApiKey = envVars.DEEPSEEK_API_KEY || envVars.ANTHROPIC_API_KEY
              || envVars.OPENAI_API_KEY || envVars.API_KEY || '';
          }

          if (rootConfigModel) {
            profiles.push({
              name: rootConfigProvider || 'hermes',
              model: rootConfigModel,
              isDefault: true
            });
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (profiles.length === 0) return { detected: false };

    const providers = profiles.map((p, i) => {
      // 尝试从 config.yaml 提取 API Key
      let apiKey = '';
      let configBaseUrl = null;
      const configPath = path.join(profilesDir, p.name, 'config.yaml');
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf-8');
          const kv = this._parseHermesConfig(content);
          // API Key — 补充 DEEPSEEK 查找
          apiKey = kv.anthropic_api_key || kv.openai_api_key || kv.api_key
            || kv.ANTHROPIC_API_KEY || kv.OPENAI_API_KEY || kv.API_KEY
            || kv.DEEPSEEK_API_KEY || kv.deepseek_api_key
            || '';
          // 真实端点
          configBaseUrl = kv.base_url || kv.api_base || kv.openai_api_base || null;
        }
      } catch (e) { /* ignore */ }

      // 如果 profile config 中没找到 key，用根配置的 key（方案3提取的）
      if (!apiKey) {
        apiKey = rootApiKey;
      }

      // 如果 config 中没有，检查环境变量 — 补充 DEEPSEEK_API_KEY
      if (!apiKey) {
        apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
      }

      // 如果还没有，从 .env 中读取
      if (!apiKey) {
        apiKey = envVars.DEEPSEEK_API_KEY || envVars.ANTHROPIC_API_KEY
          || envVars.OPENAI_API_KEY || envVars.API_KEY || '';
      }

      const baseUrl = rootConfigBaseUrl || resolveEndpoint(p.model, configBaseUrl) || `http://127.0.0.1:${8642 + i}`;

      // 根据模型名判断 apiType
      const modelLower = (p.model || '').toLowerCase();
      const apiType = (modelLower.includes('claude') || modelLower.includes('anthropic'))
        ? 'anthropic-messages' : 'openai';

      return {
        id: 'hermes-' + p.name.replace(/[^a-zA-Z0-9]/g, '-'),
        name: `Hermes / ${p.name}${p.model !== 'unknown' ? ' (' + p.model + ')' : ''}`,
        baseUrl,
        apiKey,
        modelId: p.model !== 'unknown' ? p.model : 'hermes-agent',
        apiType: 'openai',
        source: 'hermes',
        sourceLabel: 'Hermes Agent'
      };
    });

    return { detected: true, providers };
  }
}

module.exports = { LLMClient };
