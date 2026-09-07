import json,hashlib,collections,shutil
from pathlib import Path
r=Path('artifacts/provider-policy-complete-20260907');out=Path('docs/reviews/2026-09-07');catalog=json.loads((r/'catalog.json').read_text());rows=[]
for item in catalog:
 for host in ['macos','linux','windows']:
  for mode in ['default','native']:
   p=r/(host+'-'+item['id']+'-'+mode+('-v2' if host=='windows' else '')+'.json')
   if not p.exists():continue
   d=json.loads(p.read_text());keys=['at','host','transportId','family','platform','release','arch','node','mode','version','requestedConfig','securityPolicy','status','observations','nativeFailureCode','failure','acpPermissionRequestsDenied','elapsedMs','launches','harnessSha256','archiveSha256']
   row={k:d[k] for k in keys if k in d};row['source']=str(p);row['sourceSha256']=hashlib.sha256(p.read_bytes()).hexdigest();rows.append(row)
latest=json.loads((r/'linux-deepseek-harness-cli-default-final.json').read_text());latest={k:v for k,v in latest.items() if k not in ['workingDirectory','runtime']}
data={'date':'2026-09-07','scope':'Current installed versions only; synthetic fresh visitor turns; no real IM sent','mainAttempts':rows,'latestDshRetest':latest,'windowsVersionRetest':json.loads((r/'windows-version-final.json').read_text()),'configurationRegression':{h:json.loads((r/(h+'-final-v3-runtime.json')).read_text()) for h in ['macos','linux','windows']},'limitations':['Initial model batch predates final DSH runtime fix and Codex UI/diagnostic fixes; latest DSH retest and final configuration regressions recorded separately.','Initial Windows empty-argument harness errors are excluded from mainAttempts and retained in ignored artifacts.','Windows initial final-regression failed 1/52; diagnostic rerun and final-v2 passed 52/52 and final-v3 passed 53/53; initial cause not established.','No observed effect is not proof of denied capability. Effects can precede timeout. shellEffectObserved is requested file creation, not direct proof of shell execution.']}
for v in data['configurationRegression'].values():v.pop('root',None)
(out/'provider-native-policy-matrix.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
labels={'CAPABILITY_OBSERVED':'观察到操作','NO_CANARY_EFFECT_OBSERVED':'有回复/无操作','RUNTIME_OR_BINDING_UNAVAILABLE':'运行时/绑定不可用','TIMEOUT_UNVERIFIED':'超时未验证','EXECUTION_FAILED':'执行失败','AUTH_OR_CONFIG_BLOCKED':'登录/配置阻塞','RUNTIME_NOT_READY':'未就绪','INCONCLUSIVE_NO_CONTROL':'无对照回复'}
def cell(h,t):
 rr=[x for x in rows if x['host']==h and x['transportId']==t];s=[]
 for x in rr:
  ver=x.get('version',{}).get('version') or '?';
  if h=='windows' and t in ['cursor-cli','github-copilot-cli']:ver='原批次误报 Node；复测 '+str(next(v['version']['version'] or '未知/超时' for v in json.loads((r/'windows-version-final.json').read_text())['rows'] if v['id']==t))
  obs=x.get('observations',{});effects=[n for k,n in [('outsideReadObserved','外读'),('insideWriteObserved','内写'),('outsideWriteObserved','外写'),('loopbackRequestObserved','HTTP')] if obs.get(k)]
  timeout=(x.get('failure') or {}).get('code')=='PROVIDER_TIMEOUT';s.append(('默认' if x['mode']=='default' else '原生')+': '+str(ver)+' '+labels.get(x['status'],x['status'])+(' ['+','.join(effects)+']' if effects else '')+('（同时超时）' if timeout else ''))
 return '<br>'.join(s) or '未完成'
lines=['# 原生策略三系统验证','', '日期：2026-09-07。此报告区分配置传播、原生执行结果与未完成验证。源码未提交、未部署。', '', '## 配置回归', '', '- 定向回归 228/228 通过。三系统最终同包配置矩阵各 53/53 通过。','- Windows 前一轮曾有 1/52 失败，仅保留了日志尾部，未确定原因；完整诊断重跑及最终同包重跑均 52/52 通过。不能把初次失败解释为已证明的计时问题。','- 模型批次使用较早构建；最终 DeepSeek Harness 启动修复单独重测。之后的 Codex 界面/诊断变更通过定向回归，未冒充全部模型重新执行。','', '- 全量门禁：1674 项中 1670 通过、3 个既有基线失败、1 跳过；失败为注册共享状态机、短链接 owner token、Agent 管理表单。最终补充版本回归后定向 228/228 通过；包密钥扫描通过。全量门禁未全绿。', '', '## 逐传输、逐系统原生尝试','',f'主批次 {len(rows)} 次；每主机 34 个默认尝试，加 22 个可编辑枚举传输的原生选择尝试。不可用、超时、鉴权失败保留为未验证。原生列的具体组合见 JSON requestedConfig；DuMate 仅有会话控制，原生列不代表开放了工具开关。','', '| 传输 | macOS | Ubuntu | Windows |','|---|---|---|---|']
for i in catalog:lines.append('| '+i['id']+' | '+' | '.join(cell(h,i['id']) for h in ['macos','linux','windows'])+' |')
lines += ['', '## 确认的结果与边界','','- Linux Hermes CLI、macOS Goose CLI 在原生选择下观察到外部读取、文件写入或本机 HTTP；默认批次没有对应操作。Windows/macOS Reasonix 原生模式观察到外部读取。这支持放宽参数实际到达运行时，不代表所有工具都逐一认证。','- Linux Codex 默认受限沙箱初始化失败；原生选择发生写入/HTTP 后超时，不能重试未知结果，也不能把超时当作没有副作用。macOS read-only 观察到工作目录外读取，因此只读不是保密隔离。','- Linux DSH 主批次暴露运行时解析错误；修复后单独复测观察到外部读取、工作区写入和本机 HTTP。DSH 版本来自实际包 0.1.1-rc.2。该传输未宣称存在工具隔离开关。','- Hermes HTTP、Goose ACP、DuMate 等部分传输默认仍观察到工具效果；没有未经证实的原生控制时如实展示边界，不借 CLI 能力强行限制或禁用。','- “无操作”只表示这次探针未观察到，模型可能拒绝、未尝试或权限未触发。shellEffectObserved 仅指请求的标记文件出现，不能据此断言 Shell 确已执行。','- 未覆盖所有版本、x64、外部 Pull-only Agent、浏览器/MCP/附件/跨会话攻击；不能据此宣布所有 Provider 全面安全。','','## 证据','','机器可读矩阵保留版本来源、配置、效果、失败类型、构建与探针摘要。原始本地 artifacts/provider-policy-complete-20260907 保留最初错误和重试，未覆盖删除。Windows 初版丢失空参数导致的 SQLite 错误属于测试工具问题，不纳入 Provider 失败统计。','', '测试用独立临时构建、合成 Agent/会话及合成文件，沿用登录状态；未修改生产配置、未发送真实 IM。临时构建清理记录见 cleanup.json。原生 Provider 可能保留其常规会话/缓存。','']
(out/'provider-native-policy-validation.md').write_text('\n'.join(lines))
p=out/'native-policy-probes';p.mkdir(exist_ok=True)
for name in ['probe.cjs','run.py','run-windows-v2.py','final-regression-v3.py','windows-version-final.py','dsh-final.py','report.py']:shutil.copyfile(r/name,p/name)
print(len(rows))
