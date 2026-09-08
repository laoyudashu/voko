# 群协作编码实施记录

**上线更新（2026-09-08 UTC）：P1 已部署并验收。** Chatroom API/Web 均为 `43ac6e9`，生产 MySQL 已执行 `008`，项目开关已开启。整合版 207 项测试、真实线上会话/群权限与看板验收通过，43 个群订阅检查无差异。资产与 Agent 执行仍未开放。下文保留此前本机实现阶段记录，最新发布、备份和回退状态见[线上部署记录](/Users/laoyu/Documents/ChatGPT/reviews/group-projects-release-20260907/status.md)。

用户已授权开始编码。按独立审查收紧首版交付：Chatroom 为完整项目入口，Lite 负责后续实际执行；保留平行计划看板，暂不做计划表格、执行后改规格及自动完成联动。

## 当前增量：P1 项目与计划

代码分布：

- `voko-chatroom`：三张项目/计划/活动表的迁移文件，项目服务与鉴权路由，项目页面、群聊入口、双语文案，服务/接口及浏览器验证工具。
- `open_voko`：修复原群公告无法通过 Lite 清空的问题，增加空值与省略字段的行为回归测试。
- `voko-server`：未变更。本阶段不新增另一套身份、任务或存储服务。

已实现项目启用/暂停/恢复、看板新增与编辑、负责人和截止日期、拖动与状态选择、公告复用、内部规则、成员和活动记录。普通群默认不启用项目。服务端开关 `VOKO_PROJECTS_ENABLED` 默认关闭。

任务与资产页显示实际未开放状态；未提供云凭证填写或文件上传入口。此增量不等于多 Agent 执行已完成。

## 与原计划的具体调整

1. 优先完成 Chatroom 项目管理；不要求双 Web 同时完整交付。
2. P1 仅增加当前确实使用的三张表，没有一次创建原稿全部 10 张表。
3. 计划状态完全由人维护，尚无任务联动或自动质量验收。
4. 当前项目级版本号保护配置和看板变更；执行规格多版本未实施。
5. `auth_version` 将与实际任务领取、动态撤权及旧回执拒绝一起交付；目前只有每请求核对成员资格，不声称已实现执行授权代际。
6. 现有 A2A 的身份域、附件上传及持久化协议没有被直接复制。P3 仍需具体验证 `dispatcher.executeIsolated`、会话隔离与恢复组件的适配边界。

## 验证与限制

- Chatroom 新增服务/接口/请求边界测试 19 项；补齐 7 组真实 MySQL 场景及其测试入口后，完整测试 156 项通过、0 失败、0 跳过。
- Chatroom Web 构建通过。
- Lite 构建及群页面测试 16 项通过，包含公告清空回归。
- 国际化检查在修改前的 HEAD 与当前代码都报告 `Me.vue` 的四处既有硬编码；未为通过检查隐藏或跳过该问题。
- 快速服务测试仍使用 SQLite 夹具；新增真实 MySQL 8.4.11 验证，覆盖历史结构升级、`008_group_projects.sql` 重复执行、原群数据保留、外键与约束、计划和公告持久化、真实并发连接、成员行锁等待时撤权、数据库触发器故障回滚、跨项目拒绝及 BIGINT 精度。
- 浏览器 11 项验证已在真实 MySQL 后端通过：新增、状态选择、拖动、重新加载、公告清空、内部规则保存、能力门禁、手机布局、普通成员管理权限拒绝、撤权清除页面、启用项目。使用隔离的本地预览、测试身份和测试数据；不是生产登录或真实 Agent 交付证据。
- 七牛账号及私有空间已完成注册与验证。已读取用户指定的独立报告，12 项通过，包括受限用户临时上传/下载、SHA-256、元信息/列举、匿名/篡改/越权拒绝和到期失效。报告明确未验证 Voko 动态成员授权、第二空间隔离、浏览器跨域及大文件。
- 未部署、提交、推送或执行生产迁移。MySQL 测试使用本机独立进程和 Unix socket，无网络监听、不读取生产配置；测试库已清理，测试进程在验证后停止。官方程序包留在本机缓存供复测。

测试夹具首次尝试用预处理协议创建故障触发器时，MySQL 返回 `ER_UNSUPPORTED_PS`；已将仅用于测试的触发器 DDL 改为普通查询协议，并实测回滚通过。未通过修改业务代码或绕过数据库错误来让测试通过。

迁移最初编号为 `007`；部署核对发现另一个 Chatroom 工作区已有 `007_group_membership_sync.sql`，因此本次项目迁移调整为 `008` 并重新验证。没有修改另一工作区的迁移或产品代码。

持久证据：[本机验证报告](/Users/laoyu/Documents/ChatGPT/reviews/group-collaboration-20260907/validation.md)、[完整 MySQL 回归日志](/Users/laoyu/Documents/ChatGPT/reviews/group-collaboration-20260907/mysql-full-test.log)、[七牛独立报告副本](/Users/laoyu/Documents/ChatGPT/reviews/group-collaboration-20260907/qiniu-validation.md)。七牛原报告来自 `/tmp/voko-qiniu-validation.FUVjxM/report.md`，没有读取或复制密钥。

## 哪些组件需要部署

当前增量需更新 **Chatroom 业务 MySQL、Chatroom API 和 Chatroom Web**。Lite 的公告清空修复随各设备客户端更新交付；AgentDID / `voko-server` 与 WuKongIM 本阶段不需变更。本机测试无需先部署线上。

后续资产与执行仍沿用这些职责：Chatroom 管项目权限、受限凭证和短期文件授权、任务状态；客户七牛空间保存文件；各成员设备的 Lite 执行 Provider 并直传直取。文件正文不进入 Voko 服务或数据库。

上线前还需核对准备发布的 Chatroom 分支、线上 MySQL 版本与实际表结构，备份后显式迁移、部署 API/Web，再打开 `VOKO_PROJECTS_ENABLED=1`。当前开关只开放项目与计划，不能据此宣布完整多 Agent 协作上线。详细部署表及复测方式见 `voko-chatroom/docs/group-projects.md`。

## 后续依赖

P2：以已通过的七牛 S3 基础读写为起点，补齐防覆盖/稳定引用、浏览器跨域和目标文件类型验证；实现 Voko 凭证保管、动态成员签发、上传确认与固定资产引用，并验收客户云资产链路。无需再注册测试账号。

P3–P4：明确主人授权与执行契约，完成 Lite 隔离执行、attempt 持久化、未知结果恢复，再实现并行任务及前序资产汇总。不得把本次看板状态当成 Agent 实际执行状态。

P5：P1 的本机 MySQL 验证已经完成；随 P2–P4 增量继续验证新增表、执行撤权与故障，并在不同主人/设备/Provider 上补齐真实交付验收，之后再评估发布。

详细接口、开关、迁移与本地验证方法见 `voko-chatroom/docs/group-projects.md`。

本地测试页面截图：

- [计划看板](/Users/laoyu/.codex/visualizations/2026/09/07/01a07e14-a254-7813-aafd-48eb10625281/project-implementation/project-board.png)
- [项目设置](/Users/laoyu/.codex/visualizations/2026/09/07/01a07e14-a254-7813-aafd-48eb10625281/project-implementation/project-settings.png)
- [手机页面](/Users/laoyu/.codex/visualizations/2026/09/07/01a07e14-a254-7813-aafd-48eb10625281/project-implementation/project-mobile.png)

真实 MySQL 后端页面：[计划看板](/Users/laoyu/.codex/visualizations/2026/09/07/01a07e14-a254-7813-aafd-48eb10625281/project-mysql/project-board.png)、[项目设置](/Users/laoyu/.codex/visualizations/2026/09/07/01a07e14-a254-7813-aafd-48eb10625281/project-mysql/project-settings.png)、[手机页面](/Users/laoyu/.codex/visualizations/2026/09/07/01a07e14-a254-7813-aafd-48eb10625281/project-mysql/project-mobile.png)。
