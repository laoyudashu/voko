'use strict';
// Explicit Provider declaration, separate from transport completion and human task acceptance.
const RESULT_INSTRUCTION = `最终回复必须以单独的 voko-result 代码块结束，JSON 格式为：
\`\`\`voko-result
{"status":"succeeded","summary":"本次实际完成的工作","files":["实际输出文件名"]}
\`\`\`
status 只能为 succeeded、failed、input_required。无法执行请明确用 failed 或 input_required，不得把拒绝或计划标为 succeeded。纯文本成果允许 files=[]，把成果写入 summary；文件任务必须列出本轮真实生成的所有文件，仅列输出目录内的文件名。业务验收由任务负责人决定。`;
function parseProjectResult(content) {
  const matches = [...String(content).matchAll(/```voko-result\s*\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1 || String(content).slice(matches[0].index+matches[0][0].length).trim()) return null;
  let value;try { value=JSON.parse(matches[0][1]); } catch { return null; }
  if (!value || !['succeeded','failed','input_required'].includes(value.status)
      || typeof value.summary!=='string' || !value.summary.trim() || value.summary.length>50000
      || !Array.isArray(value.files) || value.files.length>20
      || value.files.some(name=>typeof name!=='string'||!name||name.length>255||name==='.'||name==='..'||/[\\/\0]/.test(name))
      || new Set(value.files).size!==value.files.length) return null;
  return {status:value.status,result:value.summary,files:value.files};
}
module.exports={RESULT_INSTRUCTION,parseProjectResult};
