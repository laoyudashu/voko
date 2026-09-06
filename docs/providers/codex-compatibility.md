# Codex 版本兼容与访客权限

更新日期：2026-09-05。范围为 VOKO → `codex-cli` 的访客任务。`codex-app-server` 的主人会话、Codex → VOKO MCP、登录和模型额度是独立路径。

## 判定与升级

兼容性按当前可执行文件检查，不把大于某版本号等同于安全，也不再只登记 `0.151.0-alpha.7.1`。相同规则用于旧版、当前版和未来未知版本：

1. 从实际解析入口执行 `--version`、根命令和 `exec` 帮助；检查 JSON 输出、只读/工作区沙箱、Profile、禁止审批及 `exec resume` 参数。
2. 检测当前平台的原生 `sandbox` 命令形态，包括直接命令形式和旧式平台子命令。
3. 使用临时 `CODEX_HOME` 和专用工作目录运行固定文件读写检查（macOS/Linux 用 Node，Windows 用系统 cmd 的固定批处理脚本，并由父进程独立检查文件）：只读拒绝两处写入；工作区可写允许工作区写入、拒绝工作区外测试文件写入。检查结束即删除测试目录。不调用模型，不使用用户配置，不保存凭证。
4. 参数与沙箱检查均通过后，开放 `sandboxMode`；仍不声明模型回复、IM 投递已验证。缺少参数、超时、无权限创建测试目录、沙箱初始化失败或写入检查失败，都不开放沙箱选项，访客任务在提交前返回原因。

在“访客安全与权限”点击“重新检测”可强制复验。成功证据缓存 24 小时，失败短缓存 30 秒；并发检测合并。运行入口、符号链接目标、文件时间/大小、npm 原生载荷替换都会使证据失效，即使版本号未变。探测中发生替换不会保存旧结果；已解析的旧权限快照也不能提交到替换后的运行文件。

这是运行能力检查，不是软件供应链完整性认证。文件元数据指纹不能识别蓄意伪造的运行文件。探测检查 Codex 原生沙箱后端与调用参数契约，不等于对所有工具、MCP 服务、Hooks、用户 Profile、系统管理策略或第三方分支的完整安全审计。

## 权限语义

| 控制 | 行为 |
| --- | --- |
| 默认 `read_only` | 传递 `--sandbox read-only`；限制写入，仍允许执行命令和广泛读取宿主机文件 |
| `workspace_write` | 传递 `--sandbox workspace-write`；允许写入工作区；Codex 原生配置及临时目录规则仍适用 |
| 审批 | 固定 `--ask-for-approval never`，首次与恢复调用一致，不在失败时切换到绕过沙箱 |
| 网络 | VOKO 没有独立、可验证的配置开关 |
| 补充提示语 | 只是指令，不提供操作系统权限边界 |

恢复调用把沙箱和审批参数放在 `exec resume` 之前，避免将根级参数传给不接受它的恢复子命令。权限快照、会话绑定及扩大权限确认沿用已有机制。

## 检测失败诊断

能力快照的 `securityDiagnostic` 保存失败阶段（例如 `sandbox:workspace-write`）、退出码、超时标记和最多 400 字符的脱敏错误摘要，权限页面展示该摘要。诊断不会授予额外权限。

- `CODEX_SANDBOX_INITIALIZATION_FAILED`：原生沙箱初始化错误，例如 Linux bwrap 权限被系统拒绝。
- `CODEX_PROBE_EXECUTION_FAILED`：探针程序未正常执行，例如 Windows `0xC0000142`；不据此断言所有沙箱能力失效。
- `CODEX_PROBE_TIMEOUT`：探针超过执行期限。
- `CODEX_SANDBOX_CANARY_FAILED`：文件边界不符合请求的模式，包括工作区写入被拒绝。

只读与工作区写入仍需同时验证通过，未引入部分模式开放。Windows 固定脚本不包含用户消息，也不根据本地化错误文本猜测写入是否成功。

## 本次实测

| CLI 版本 | 平台 | 参数契约 | 原生沙箱读写检查 | 模型回复 / 真实会话恢复 / IM 投递 |
| --- | --- | --- | --- | --- |
| 0.148.0 | macOS arm64 | 通过 | 通过 | 本次未测 |
| 0.151.0-alpha.7.1 | macOS arm64 | 通过 | 通过 | 本次未测 |
| 0.153.4 | macOS arm64，本机实际入口 | 通过 | 通过 | 真实模型首轮与原生会话恢复通过；IM 未测 |
| 其他版本 | 当前宿主环境 | 自动检查 | 自动检查，通过才开放权限 | 不据此宣称已验证 |
| 0.148.0 | Ubuntu arm64 | 通过 | bwrap 初始化被系统拒绝 | Provider 提交前阻止；未调用模型 |
| 0.148.0 | Windows 11 arm64 | 通过 | 系统 cmd 探针完成只读检查；workspace-write 仍拒绝工作区写入 | Provider 提交前阻止；未调用模型 |

上述三个版本使用直接 `codex sandbox` 形式；旧式 `sandbox macos/linux/windows` 分支仅有模拟契约测试，未在本次真机矩阵验证。历史 Windows 0.145.0 的真实投递记录见 [Codex 指南](codex.md)，不自动视为本次改动的 Windows 验收。

可重复执行（先完成构建）：

```bash
node scripts/probe-codex-compatibility.js /absolute/path/to/codex
```

脱敏实测记录与帮助契约保存在 `test/fixtures/codex-compatibility/runtime-probes.json`；自动回归位于 `test/codex-version-compatibility.test.js`。测试版本下载在临时目录，本次未替换或升级已安装的 Codex。

官方参数与安全语义参考：[Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[Codex Security](https://learn.chatgpt.com/docs/security)。兼容判定以本地实际检查结果为准。
