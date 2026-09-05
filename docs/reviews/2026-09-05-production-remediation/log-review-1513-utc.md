# 三端日志复核：2026-09-05 15:13 UTC

## 当前结论与检查范围

三端仍运行 f5370c3 候选，实际运行摘要均为 `61a922d2641a6a2e7d915ffb3a4d16df7dfd1e0b5507b625509fb363a20ffa89`，与此前部署记录相同。Mac PID 77689、Linux PID 247940、Windows PID 15072 均 READY，IM 连接分别为 17/17、12/12、21/21。没有观察到本轮进程更换。

本次先读取各进程本次启动以来的 voko-im.log，再单独检查上轮网页矩阵完成后的 14:34:00–15:13 UTC 增量。时间在各主机按本地时区解析，再统一为 UTC。以下是增量窗口，不能与整个启动窗口的累计错误混为一谈。

| 主机 | 日志行数 | 新增告警 | 最近一条告警 UTC |
| --- | ---: | --- | --- |
| macOS | 39 | 0 | 无 |
| Linux | 43 | 3 次 E2EE_V2_DIRECTORY_TIMEOUT | 14:44:10 |
| Windows | 48 | 5 次 QwenOfficeReadiness，均包含原生退出码 3221225477 | 15:12:58 |

Linux 目录超时分别在 14:39:11、14:42:10、14:44:10；Windows 千问办公告警分别在 14:36:54、14:55:57、15:02:58、15:07:58、15:12:58。Windows 整个启动窗口还有 9 次目录超时，但均早于本次增量窗口。日志没有证明超时源于服务端、网络或本机停顿中的哪一项，不能据此绕过目录校验或关闭加密。

增量窗口中没有 ERR 级记录，也没有匹配到 uncaughtException、unhandledRejection、FATAL ERROR、heap out of memory、SQLITE_CORRUPT 或 SQLITE_FULL。此结论仅适用于检查的 VOKO 日志；原生千问办公程序崩溃仍真实存在，不应概括为“系统无崩溃”。

本次没有发送新的业务消息，增量窗口也没有 ProviderTurn。因此未新增网页验收结果，当前候选仍为 43/50 正确可见回复，7 个未通过；没有新业务错误不能证明启动故障已修复。没有确认新的错误类型或最新包导致的回归。

## 已有失败的新定位

### OpenHands 缺少模型配置

在修复 Python 安装路径后，隔离回环尝试于 14:51:15 UTC 返回 `Authentication required`，未进入业务 prompt，modeConfirmed=0。读取已安装 OpenHands 源码确认：本地 Agent 的认证检查实际调用 load_agent_specs；缺少 Agent 配置时，session/new 拒绝创建会话。

实际 Windows 用户目录下 `.openhands/agent_settings.json` 不存在，配置文件列表为空，未设置 OPENHANDS_PERSISTENCE_DIR 覆盖项。这将当前障碍进一步定位为模型 Agent 配置缺失，不能简单归类为 OAuth 登录过期。需要用户指定已有的模型/账号配置名称，再通过受支持流程配置；不复制其他 Provider 的密钥、不选择未经指定的计费账号。当前 Catalog 仍为 Pull-only，完成模型配置也不等于自动 Push 的安全和真机门禁已经通过。

### CodeBuddy / WorkBuddy 为间歇性启动失败，根因未定

当前候选业务日志中的 CodeBuddy initialize 15 秒超时、WorkBuddy HTTP service did not become ready 仍然有效。之后分别进行不创建业务 prompt 的独立启动诊断，CodeBuddy 约 5.4 秒建立连接；WorkBuddy 默认未绑定实例约 6.8 秒完成 HTTP readiness。这只能排除“始终无法启动”，不能证明生产 Agent 的绑定配置和会话路径均正常。特别是 WorkBuddy 默认诊断不等于生产绑定实例诊断。

14:45:53 UTC 的 Windows 采样显示物理内存约 6 GiB、可用 680 MiB，提交内存约 11.8 GiB；更早独立诊断可用内存为 0.4–0.5 GiB。宿主 Mac 为 16 GiB，曾观察到约 9.6 GiB swap 使用。Windows 单次采样的分页输入/输出为 0，不能推导持续换页或将所有故障归因于内存。资源压力目前是待验证因素，不应直接延长全部超时或增加 VM 内存。

下一步应对照实际绑定实例记录启动阶段耗时及脱敏失败原因，保持生产权限和超时不变。进程父子关系检查还确认，观察到的旧 dumate-opencode 进程属于 DuMate 桌面应用，不是已证实的 VOKO 遗留进程，不应误杀。

### DuMate 更新候选尚未验证

Windows 安装版本为 1.0.73，应用自身配置的[官方更新清单](https://dumate-app-public.cdn.bcebos.com/release-info/artifacts-update/latest.yml)提供 1.0.76。下载在 300 秒后超时，仅收到 100990143 / 714531488 字节；没有完成哈希校验、执行或安装，不能将更新候选计为修复。下一步先完成下载并按官方 SHA-512 校验，再进行隔离原生启动对照；当前生产 DuMate 未替换。

## 后续优先级

1. Windows 千问办公原生崩溃持续复现，优先取得故障模块/兼容构建对照；不把 READY 或曾经一次 status 成功当作稳定可用。
2. 对 DuMate 新版做完整性验证和隔离对照；定位 CodeBuddy、WorkBuddy 实际绑定路径的间歇性启动问题。
3. 补齐 OpenHands 模型配置及两个 AUTO-REG 的真实 Provider 映射；不为通过矩阵而替换身份或放宽权限。
4. 对目录超时保留时间线并关联实际请求阶段；继续区分正常 ACP 进度误标 ERR 与真实失败。

脱敏证据：`artifacts/production-remediation-startup-20260905/*-recent-logs.json`、`*-log-review-status.json`、独立启动、资源和 OpenHands 源码检查记录。候选整个启动窗口摘要在 `artifacts/production-remediation-openhands-20260905/*-logs.json`。本轮只更新诊断记录，没有修改或重启生产服务，也没有重新计数网页成功项。
