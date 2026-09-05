# 启动失败与 Aider 费用文字修复：2026-09-05

## 已提交的代码修复

### 47e257c：WorkBuddy 启动边界和诊断

实际生产仍有 WorkBuddy HTTP 启动超时。核对 Windows 注册数据确认 backend_instance_id 为空；使用保存的 dataFileAccess=none、permissionMode=dontAsk、sessionPersistence=conversation、mcpProfile=isolated 和生产默认临时目录做独立启动，约 7.4 秒通过健康和 OpenAPI 检查，原 20 秒预算未修改。此次结果排除了该 Agent 绑定专家实例不同的解释，但尚未排除生产进程与 SSH 探针的环境、启动命令或负载差异。

进一步编写三项最小复现，原实现全部失败：

1. 真实子进程在工作目录失效时触发未处理的 error 事件，外层 Node 进程退出；原有 Promise catch 无法接住 EventEmitter 的未处理错误。
2. 子进程在健康检查期间退出，检查响应随后完成，仍会错误报告 ready。
3. 启动超时只保留通用消息，最后一次 readiness 失败原因丢失。

修复安装子进程 error/exit 监听，健康检查后再次确认进程仍有效，启动失败统一清理本实例的进程引用及端口。错误保留 not_delivered 和 startup 阶段，并区分 WORKBUDDY_SPAWN_FAILED、WORKBUDDY_PROCESS_EXITED、WORKBUDDY_STARTUP_STOPPED、WORKBUDDY_STARTUP_TIMEOUT。诊断仅输出固定错误类别、允许的系统错误码或 HTTP 状态，不输出原始错误正文、stderr、启动参数或用户目录。

未修改启动预算、业务权限、后备路由或未知结果重试规则。三项新增测试和既有 WorkBuddy 测试共 18 项通过；该提交完整门禁 1568 项通过、2 项既有跳过、0 失败。这修复的是已证明的进程生命周期和诊断缺陷，不能声明当前生产间歇性启动超时已经根治。

### 9b9baff：Aider 费用摘要换行污染回复

此前 Windows 网页答案后多出独立的 `session.`。隔离原生回环显示：普通输出宽度和 60 列宽度均能精确匹配挑战；70 列时实际费用摘要为：

```text
Tokens: 123 sent, 19 received. Cost: $0.000079 message, $0.000079
session.
```

解析器过滤了首行，但把第二行当作模型答案，因此精确回环失败。新增复现原实现 1 失败、2 通过。修复仅在 Tokens:/Cost: 行以尚未完成的美元金额结尾时，消费紧接着的独立 session.；正常答案中的 session.、完整费用摘要后的同名正文、其他正文之后的同名文字均保留。

修复后 Windows 同样 70 列的真实回环成功，原生费用摘要仍有换行，证明改变的是解析结果而非测试输出。相关 Provider、解析器和 WorkBuddy 组合 76 项通过。最终完整 release:gate:code：1571 项通过、2 项既有跳过、0 失败；类型检查、构建、i18n、覆盖率基线和源码包扫描均通过。

## 三端部署和真机网页验收

同一份本地 @voko/lite 0.5.2 包包含两项修复，未发布 npm registry。

- tarball SHA-256：`8abd2c6d71feb012050d0ab534e2beaf9dd4950a078780e272e4b9783160d36d`
- 三端构建摘要：`2d0223c0f3a76e4d4eeeffb4fc077beb9877cb415bc5e3bc8b5227f49ea343c3`，312 个构建文件。
- Mac PID 22176、Linux PID 252984、Windows PID 11672 均 READY，IM 分别 17/17、12/12、21/21，buildMismatch=false。
- 部署前备份包和数据库；实际包扫描 320 个文本文件无发现；安装后的 6 项新增测试在三端分别全部通过。
- Windows 安装过程中一次并发 status 读取遇到临时模块缺失；等待同一次安装和计划任务启动完成后，摘要及安装包测试全部通过。没有因此重复安装或重启。
- Mac DuMate、千问办公 o9 在本次重启后重新完成实际回环；Windows DuMate 回环再次原生退出 3221225477，未修改投递权限。

15:52:10–16:01:32 UTC，通过 macOS Chrome 向原有全部 50 个身份各发送一条 `VOKO_UI_9B9BAFF_R1_` 消息。至 16:07:10 UTC 完成逐项网页复核，无 R2 消息或未知结果重放。

| 平台 | 正确答案在网页可见 | 未通过 |
| --- | ---: | ---: |
| macOS | 16/17 | 1 |
| Linux | 12/12 | 0 |
| Windows | 16/21 | 5 |
| 合计 | 44/50 | 6 |

44 个正确可见回复均有本候选启动窗口内对应的 generated/delivered 记录。窗口内后台日志只是补充证据，没有替代网页验收。Windows Aider 的最终正文只有“7加8等于15。”，未再夹带费用标签。CodeBuddy 本轮通过 ACP 实际回复；此前间歇性失败仍保留为历史，不因本次成功而认定稳定性根治。

一些会话首次切回仍显示旧的处理中状态，再次进入并完成历史同步后正确回复出现。Aider 的后台交付及网页显示存在时间差，最终实际页面已经确认；尚未据此确认永久丢失或唯一前端根因。Mac Copilot 答案正确，但另有英文解释，不满足严格一句话格式，单独保留问题，未扩大为全面质量通过。

## 剩余六项及下一步

| Agent | 当前证据 | 下一步 |
| --- | --- | --- |
| AUTO-REG-MAC-20260828 | backend=others，网页自动回复未启用 | 等待实际 Provider 映射，不替换原身份 |
| AUTO-REG-WINDOWS-20260828 | 同上 | 同上 |
| TEST-WINDOWS-OPENHANDS | Catalog 仍 Pull-only；已安装本地 Agent 缺少模型配置，session/new 返回 Authentication required | 指定已有模型/账号配置后配置，再完成权限拒绝、恢复会话和原生 Push 门禁 |
| TEST-WINDOWS-QWEN-OFFICE | 原生 readiness 故障持续，未取得有效回环，网页自动回复未启用 | 原生兼容性/故障模块对照，不用超时增大或身份替换掩盖问题 |
| TEST-WINDOWS-DUMATE | 当前包的回环和网页业务仍原生退出 3221225477 | 继续原生兼容性定位；本轮官方新版也失败，不能据此升级为已修复 |
| 394591614的workbuddy-n3WNrD | 本轮 WORKBUDDY_STARTUP_TIMEOUT，最后一次检查 ECONNREFUSED，durationMs=21597，outcome=not_delivered | 对照生产与独立探针实际启动命令、环境和启动阶段耗时；不直接延长所有超时 |

WorkBuddy 新日志明确表明本次失败发生在服务尚未就绪时；网页“调用超时”不能理解为模型已经接收请求。另有 E2EE 通用日志仍写“Provider 结果未知，未自动重试”，与同一 turn 的 not_delivered 不一致；继续追踪诊断分类文案，不能据此擅自重放请求。

## DuMate 官方新版对照

应用自身[官方更新清单](https://dumate-app-public.cdn.bcebos.com/release-info/artifacts-update/latest.yml)提供 1.0.76。完整安装包 714531488 字节及 SHA-512 均与官方清单匹配。提取的新版原生程序和现有原生程序均通过 Windows Authenticode 验证，签名主体为 Beijing Baidu Netcom Science and Technology Co., Ltd.；未执行安装器或替换桌面应用。

隔离对照使用相同测试流程、独立临时目录和数据目录，不发送业务 prompt：现有 1.0.73 所带 CLI 的 --version 和 serve readiness 本次成功；1.0.76 所带 CLI 的 --version 和 serve 均退出 3221225477。因此没有证据支持“升级到 1.0.76 即修复当前环境”。该对照也不证明旧版永久稳定或新版在所有系统均故障。

第一次诊断因停止后的短暂文件占用在清理阶段 EBUSY 退出，未保存完整对照结果，未作为启动结论。检查进程清单未发现残留测试进程，保留的 DuMate 进程均属于既有桌面应用。改为等待测试子进程退出并有限重试清理后，上述对照完整记录；已清除该次遗留的专用测试数据目录。

## 证据

`artifacts/production-remediation-startup-20260905/`：生产配置启动对照、原始及修复后 Aider 隔离回环、DuMate 下载完整性/签名/原生对照、脱敏 WorkBuddy 本轮错误。

`artifacts/production-remediation-startup-fixes-20260905/`：不可变候选包、备份、安装记录、三端摘要、安装包测试、回环结果、当前日志和 browser-matrix.json。execution.json 保存原有候选历史及全部 50 项当前证据。整体目标继续 active，尚未完成。
