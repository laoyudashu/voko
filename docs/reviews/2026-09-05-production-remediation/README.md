# 三端生产回归与问题修复

用户目标：修复问题并提交，在 macOS 网页端对当前三端全部 Agent 做真实对话测试，遇到问题自动修复和回归，直至完成。目标仍在进行中，不能用少量成功 Agent 代替全部验收。

`execution.json` 保存初始 50 个 Agent 的逐项台账（Mac 17、Linux 12、Windows 21）；最终验收必须重新核对当前清单。历史聊天中已注销的 Agent 不代替当前已注册 Agent。登录、额度、Pull 模式和外部服务限制均要记录，不能伪造成功。

## 第一批：终态回执恢复

最小复现：Provider 已完成，终态回执 deliver 返回 ECONNRESET，原实现立即清理 receiptRequests/receiptSourceAliases，因此后续没有保留的补发上下文。新增测试在原代码上失败，修复后通过。

修复范围：保留不可变终态回执（同一 messageId、sequence、source IDs），仅补发回执；成功后清理上下文。最多 1000 个待补发条目、最多 5 次总尝试、10 分钟有效期、30 秒重试间隔，每轮最多 4 个并发；到期明确记录日志。重试不重新调用 Provider，不放松目录、身份、加密校验，也不伪造业务成功。关闭时停止新补发并清理内存，旧异步结果不能丢弃更新后的条目。失败日志只记录经过约束的错误码，不打印原始错误文本。

这解决暂时交付失败的恢复缺口，不代表 PEER_NOT_FOUND、历史加密锁或 Provider 登录问题已经解决。待补发上下文是实例内存状态，和现有 get_message_result 的实例生命周期一致；没有声称跨重启持久恢复。

验证：类型检查通过；消息回归 56 个 Node 测试和 16 个群消息检查通过；回执/结果存储 10 个测试通过；更早的契约组合 37 个测试通过（数量重叠，不相加）。完整 `release:gate:code` 门禁通过：1537 项通过、2 项既有平台跳过、0 失败；覆盖率基线、类型检查、build、i18n 和源码包扫描均通过。

## 三端部署和第一轮网页证据

第一批 `fa45ecb` 的同一 tarball 已安装到 Mac、Linux（两个现存全局前缀）、Windows；各端先保存包和 SQLite 在线快照。包 SHA-256 为 `6ba3e9973001013cb0275985609f80c8bb55a7b546e6668f38545edbcf4d6da3`，三端实际构建摘要均为 `d7e84cd1325d0c24b451d9617fa9e531eca64da3a65b4fa87ede7901832168c0`。这是本地候选 npm 包，没有发布到 npm registry。

最新采样三端均 READY：Mac PID 49058（17/17 IM），Linux PID 228641（12/12 IM），Windows PID 12744（21/21 IM）。Windows 由原有 VOKO-Debug-Manual 计划任务启动。启动期间 status 一度显示 stopped，但随后同一 PID 持续运行并 READY；不能把先前状态查询单独作为进程崩溃的证据。

截至本轮记录，已通过 macOS Chrome 实际发送 15 个 Agent 的测试消息，问题为“请用一句中文回答：2加3等于多少？”。Mac Hermes、Linux Claude、Linux Qwen 的网页均已显示“2加3等于5。”。日志中对应 14 个 ProviderTurn 记录 generated/delivered；其余结果仍需逐个回到网页核对，不能将日志交付当作网页验收。Mac DuMate 的网页明确显示“Agent 尚未启用自动回复”，日志为 AUTOMATIC_DELIVERY_DISABLED。

当前仍未解决：Windows Qwen Office 原生命令曾返回 3221225477，且仍有状态查询超时；Windows Hermes models 探针仍出现 401；历史 PEER_NOT_FOUND/加密锁未全部恢复；两个 backend=others 注册对象的实际 Provider 尚待用户说明。启动及同步期间仍有 A2A、目录请求超时，部分有恢复日志。暂未取得将这些问题归因于本次包变更的证据。

网页交互中出现多次自动化超时。后续原生应用工具明确报告 Mac 已锁定且自动解锁失败，需要用户手动解锁；不能将这些自动化超时直接计为 VOKO 回归。未重复发送已在页面出现的测试消息，未关闭加密或改变 Agent 可见性。网页全量验收仍未完成。

## 第二批：Windows 进程查询失败必须与进程不存在区分

本次启动状态观测促成代码复核，但未保存当时 CIM 调用的退出状态，因此不能断言每次 stopped 均由此原因造成。代码缺陷和最小复现则已确认：`inspectWindowsProcess` 将超时、非零退出、无效 JSON 与成功查询但进程不存在都返回 null。`acquireInstanceLock` 会把这一 null 当作旧实例已退出并移除旧锁；停止流程也可能误报退出已确认。

修复使用既有错误传播路径：CIM 采用 ErrorAction Stop，单个及批量进程查询失败抛出固定错误码 PROCESS_INSPECTION_FAILED；成功的空结果仍表示进程不存在。status 对该错误明确输出 unknown/running=null。没有放宽 PID/创建时间匹配，没有用 PID 存活代替身份验证，也没有提高超时或加入后台轮询。权衡是查询不可用时相关操作会失败并保留锁，而非声称进程已退出。

新增故障注入测试覆盖超时、非零退出、无效 JSON 下的进程检查、退出确认、终止和旧锁保留，以及批量 worker 查询；保留成功空查询与有效身份的对照。原实现 6 项失败/2 项通过；修复后扩展为 11 项全部通过。进程生命周期组合 19 项通过、1 项平台跳过（与新增测试有重叠，不相加）。完整 release:gate:code 门禁通过：1548 项通过、2 项既有平台跳过、0 失败；类型检查、构建、i18n、覆盖率基线和源码敏感信息扫描均通过。

原始证据位于忽略目录 `artifacts/production-remediation-20260905/`；其中保存主机备份清单、当前状态、日志摘要、安装结果和候选 tarball。逐项进度在本目录 `execution.json`，状态保持 active。
