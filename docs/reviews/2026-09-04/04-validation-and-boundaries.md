# 验证与自动执行边界

本文是批准后执行计划的公共约束；当前只记录，不运行产品修复、构建或完整测试。

本轮环境快照：本地 `node --version` 为 `v26.7.0`，npm 为 `11.19.0`；当前 CI 使用 Node22/24。内存探针结果不可替代 CI 版本验证。批准后先选择隔离的 Node22 运行环境（不替换用户全局 Node），并记录实际二进制/版本；若未能完成该环境准备，必须把 CI 版本验收标为未完成。

## 当前已检查的工程入口

- `package.json`：typecheck、build:ts、test:ci、test:e2e、release:gate:code、package:build、security:*。
- `scripts/run-test-layer.js`：自动发现 `test/*.test.js`；新文件默认 component；build-mutating 与 process-sensitive 分组串行；其他文件默认并发4。
- `test/test-matrix.json`、`test/coverage-policies.json`：分类和基线/目标；不得为了让本次修复通过而降低门槛。
- `scripts/start-e2e-voko.js`、`playwright.config.js`、`test/support/runtime.js`：临时数据库、假服务和隔离端口。
- `.github/workflows/ci.yml`：PR 为 Node22 三 OS 与 Chromium；main 扩展 Node22/24 和三浏览器；Rust E2EE、Security、依赖审查另有门禁。
- `.github/workflows/codeql.yml`、`scripts/run-codeql.js`、`scripts/scan-package-secrets.js`、release-npm workflow：静态安全与发布制品检查边界。

## 验证设计注意事项

1. 浏览器测试默认带 `x-voko-token`，走实例身份通路。新增 owner Cookie/CSRF 测试必须显式不带该头，使用合成登录会话，否则无法验证实际浏览器账号边界。这是覆盖设计要求，不是指现有 E2E 已失败。
2. `test/offline-sync.test.js` 部分测试自行实现解码/映射逻辑，另有部分真实导出测试。新增 gap、事务回滚和分页测试必须调用真实同步函数，避免仅测试复制代码。
3. 回归用例优先验证业务不变量：拒绝不授权、资源归属不被参数替换、事务失败不执行、未知结果不重试、停止后不新执行、暂时解密失败可重试。
4. 主线程性能使用隔离、可终止的进程/worker 和合成数据测量；不得在真实运行时执行恶意正则。性能门槛应比较同一机器上的前后结果与算法工作量，避免脆弱的统一毫秒断言。
5. 路径删除测试仅使用虚拟文件系统或单次创建且有明确归属的临时目录，绝不把真实应用数据目录作为测试根。
6. WebSocket 补鉴权需同时验证：匿名拒绝、有效 Cookie、有效实例身份、非法 Origin、过期/旧 owner 会话、合法客户端重连。不要为了浏览器支持把长期实例凭据放进 URL 或页面源码。
7. 名单/会话查询需覆盖私聊、群聊、系统/控制消息、同时间戳、跨 owner、多页及空页边界。先确定契约，再优化 SQL。

## 批准后验证顺序

| 层级 | 执行条件 | 验证与产物 |
| --- | --- | --- |
| 基线 | 隔离工作树与依赖可用后 | 记录提交、Node/npm、锁文件、工作区状态；必要时 `npm ci`；运行一次现有代码门禁并保存失败分类 |
| 最小复现 | 每个入选问题，修改实现前 | 在真实模块上写确定性用例，记录旧实现失败原因；不以 AST 字符串出现替代行为验证 |
| 定向回归 | 每个最小修复后 | 构建一次后按受影响模块运行 `node --test ...`；保留退出码、用例数量、耗时与脱敏日志 |
| 汇总代码门禁 | 所有默认入选修复完成后 | `npm run release:gate:code`，覆盖 typecheck/build/i18n/unit/component/coverage/package-secret-scan；避免重复单独跑这些已包含步骤 |
| Web 集成 | Web鉴权、名单操作、会话列表等改动后 | `npm run test:e2e`，隔离运行时和假服务；补不携带实例令牌的 Cookie 场景 |
| 包契约 | 构建/分发/MCP变更后 | `npm run package:verify-schema`、`npm pack --dry-run --ignore-scripts`，核对构建对应当前源码；如补制品扫描，还需对同一待交付制品做扫描 |
| 静态安全 | 工具可用时，汇总变更后 | 运行现有 Gitleaks/CodeQL；工具缺失必须记录为未覆盖，不可宣称安全扫描通过，也不能自动修改扫描白名单绕过失败 |
| 跨平台 | 触及进程、文件寿命、路径或关闭顺序时 | 需要 Windows/macOS/Linux 回归；可用隔离测试机才运行，无授权的远端/真实账号不自动调用；本机通过与三系统通过分开记录 |

Rust/WASM 密码核心未修改时不应重建密码协议来修复本地游标或附件生命周期。若实际改动进入该核心，须补现有 Rust/WASM 门禁和对应安全复核；不得仅靠 JS 测试声称通过。

## 自动推进与停止规则

- 本轮批准对象是版本化计划及所列工作项。批准后同一任务可连续执行已授权的复现、最小修改、回归、复核和记录，无需每项重复申请。
- 自动执行不是定时任务；当前不创建后台调度器、循环提醒、CI/CD 工作流或常驻优化进程。
- 使用新的 `codex/` 分支/独立工作树，以实际批准时 HEAD 为基线重新核对差异；保护已有未提交修改，禁止 `reset --hard`/整体清理。
- 每项状态：`pending → reproducing → confirmed → fixing → validating → reviewed → done`；不成立改为 `rejected`，需要超出批准范围的变更改为 `blocked` 并记录原因。
- 单项修复失败先调查根因并做范围内调整；同一证据已明确不能支持方案时停止该项，不无限重试。独立事项仍可继续，依赖项不得强行推进。
- 确认需要公开协议变更、新依赖、历史数据迁移/清理、跨仓库修改或真实外部副作用时，先完成可审阅设计，停止受影响事项并请求增补批准。
- 现有基线失败与本次新增失败分开记录；本次引入的失败必须解决。基线失败不能被隐藏，也不能无授权扩展为全仓重构。
- 不自动推送、公开报告、开公开 Issue、合并、打标签、Release、npm publish 或部署。报告含未修复安全问题，按 SECURITY.md 保留私密披露边界。
- 最终交付包含入选事项完成状态、未完成/不成立清单、实际验证范围、剩余风险和工作区差异；“全部完成”不得包含被跳过的必要验收。
