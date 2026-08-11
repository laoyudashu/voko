// Initial values adapted from CC Switch 3.16.5 provider presets (MIT).
// Keep this list local and explicit: the audit page must not fetch remote catalog data.
const SAFETY_MODEL_PRESETS = Object.freeze([
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', apiType: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', modelId: 'deepseek-v4-flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', apiType: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', modelId: 'deepseek-v4-pro' },
  { id: 'glm-5.1', label: 'Zhipu GLM-5.1', apiType: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic', modelId: 'glm-5.1' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', apiType: 'anthropic-messages', baseUrl: 'https://api.moonshot.cn/anthropic', modelId: 'kimi-k2.7-code' },
  { id: 'step-3.5-flash-2603', label: 'StepFun 3.5 Flash', apiType: 'anthropic-messages', baseUrl: 'https://api.stepfun.com/step_plan', modelId: 'step-3.5-flash-2603' },
  { id: 'step-3.5-flash-2603-en', label: 'StepFun 3.5 Flash (International)', apiType: 'anthropic-messages', baseUrl: 'https://api.stepfun.ai/step_plan', modelId: 'step-3.5-flash-2603' },
  { id: 'qianfan-code-latest', label: 'Baidu Qianfan Code', apiType: 'anthropic-messages', baseUrl: 'https://qianfan.baidubce.com/anthropic/coding', modelId: 'qianfan-code-latest' },
  { id: 'doubao-seed-2-1-pro-260628', label: 'Doubao Seed 2.1 Pro', apiType: 'anthropic-messages', baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible', modelId: 'doubao-seed-2-1-pro-260628' },
  { id: 'ark-code-latest', label: 'Volcengine Ark Code', apiType: 'anthropic-messages', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', modelId: 'ark-code-latest' },
  { id: 'byteplus-ark-code-latest', label: 'BytePlus Ark Code', apiType: 'anthropic-messages', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding', modelId: 'ark-code-latest' },
  { id: 'modelscope-glm-5.1', label: 'ModelScope GLM-5.1', apiType: 'anthropic-messages', baseUrl: 'https://api-inference.modelscope.cn', modelId: 'ZhipuAI/GLM-5.1' },
  { id: 'longcat-2.0', label: 'LongCat 2.0', apiType: 'anthropic-messages', baseUrl: 'https://api.longcat.chat/anthropic', modelId: 'LongCat-2.0' },
  { id: 'minimax-m2.7', label: 'MiniMax M2.7', apiType: 'anthropic-messages', baseUrl: 'https://api.minimaxi.com/anthropic', modelId: 'MiniMax-M2.7' },
  { id: 'minimax-m2.7-intl', label: 'MiniMax M2.7 (International)', apiType: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic', modelId: 'MiniMax-M2.7' },
  { id: 'ling-2.5-1t', label: 'BaiLing Ling 2.5 1T', apiType: 'anthropic-messages', baseUrl: 'https://api.tbox.cn/api/anthropic', modelId: 'Ling-2.5-1T' },
  { id: 'novita-glm-5.1', label: 'Novita GLM-5.1', apiType: 'anthropic-messages', baseUrl: 'https://api.novita.ai/anthropic', modelId: 'zai-org/glm-5.1' },
  { id: 'nvidia-kimi-k2.5', label: 'NVIDIA NIM Kimi K2.5', apiType: 'openai-chat', baseUrl: 'https://integrate.api.nvidia.com', modelId: 'moonshotai/kimi-k2.5' },
  { id: 'mimo-v2.5-pro', label: 'Xiaomi MiMo V2.5 Pro', apiType: 'anthropic-messages', baseUrl: 'https://api.xiaomimimo.com/anthropic', modelId: 'mimo-v2.5-pro' },
  { id: 'mimo-v2.5-pro-cn', label: 'Xiaomi MiMo V2.5 Pro (China Token Plan)', apiType: 'anthropic-messages', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', modelId: 'mimo-v2.5-pro' },
  { id: 'opencode-go-deepseek-v4-flash', label: 'OpenCode Go DeepSeek V4 Flash', apiType: 'openai-chat', baseUrl: 'https://opencode.ai/zen/go', modelId: 'deepseek-v4-flash' },
]);

function findSafetyModelPreset(config = {}) {
  return SAFETY_MODEL_PRESETS.find((preset) => preset.apiType === config.apiType
    && preset.baseUrl === String(config.baseUrl || '').replace(/\/+$/, '')
    && preset.modelId === config.modelId) || null;
}

module.exports = { SAFETY_MODEL_PRESETS, findSafetyModelPreset };
