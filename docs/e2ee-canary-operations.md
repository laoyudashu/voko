# E2EE-TOFU 内部 Canary 运维手册

本手册只适用于精确白名单中的测试主人、Agent 和设备。生产功能必须默认关闭，
不得向普通用户展示，也不得把内部 Canary 结果表述为正式 E2EE 上线。

## 固定安全边界

- 同时满足全局开关、主人、Agent、设备和平台白名单才允许建立 Canary。
- 任一门禁缺失、KeyPackage 耗尽、Credential 变化或能力不匹配时硬拒绝，绝不降级明文。
- `outcome_unknown` 禁止跨 Provider 重投；只有确定 `not_delivered` 才允许最多一次备选通道。
- 紧急关闭必须持久化；重启后仍关闭，旧队列标记撤销且重新启用后不得自动重放。
- 纯文本 Canary 不经过 OSS。未进行附件 Canary 时，OSS 结论必须写“未覆盖”，不能写“通过”。
- 附件入口保持关闭，直到 Fake OSS、Windows 专用 Bucket 和 Ubuntu 专用 Bucket 三个门禁全部通过。

## 真实验收

Windows 和 Ubuntu 分别使用独立设备 ID。不要让 Ubuntu 直接打开 Windows 正在使用的
SQLite 文件；将在线备份复制到 Linux 本地文件系统后运行。

```powershell
npm run test:e2ee:real-canary
npm run test:e2ee:report
```

```bash
VOKO_REAL_DB_PATH=/home/voko-test/voko-canary.db npm run test:e2ee:real-canary
npm run test:e2ee:report
```

报告至少应证明双向密文、重启恢复、重复拒绝、乱序处理、断线补拉、身份变化拒绝、
KeyPackage 耗尽拒绝、非白名单拒绝，并且 `plaintextFallbacks=0`、
`capturedWirePlaintextHits=0`。报告只能包含脱敏参与者标识，不能包含 Token、正文、
Credential 私钥或完整设备标识。

## 白名单、换钥与撤销

修改服务端白名单前先备份配置。每次修改后重启服务并查询状态，确认计数符合预期。
测试设备 ID 只能使用随机、一次性的演练标识。

```powershell
npm run test:e2ee:status -- --expect=enabled
npm run test:e2ee:status -- --expect=enabled --drill-rotate=<temporary-device-id>
npm run test:e2ee:status -- --expect=enabled --drill-revoke=<temporary-device-id>
```

换钥演练必须证明新 epoch 被接受、旧 epoch 返回冲突且设备最终被撤销；撤销演练必须
证明同一设备身份无法重新注册。演练后恢复原白名单并再次核对状态。

## 紧急关闭与告警

运行时每 60 秒检查一次，最短检查间隔 5 秒。一个检查周期新增失败达到 3 次，或出现
任意一次明文 fallback，立即触发紧急关闭。关闭后应看到 `emergencyDisabled=true`。

演练步骤：备份服务配置；关闭内部 Canary 全局开关；重启并执行
`npm run test:e2ee:status -- --expect=disabled`；再次重启并重复检查；最后恢复备份配置。
不要只修改一个临时进程环境变量，也不要在未验证重启持久性的情况下宣布演练通过。

## 明文泄漏检查

每次运行生成唯一 Canary 明文标记。对以下位置做精确字节搜索：

- AgentDID 请求捕获与服务日志；
- WuKongIM 收发捕获；
- VOKO SQLite、WAL、日志和验收产物；
- 使用附件 Canary 时的 OSS 对象、manifest 和日志。

任何命中都立即停止 Canary、保全密文证据并按安全事件处理。日志不得为了排障打印
正文、Token、私钥或完整环境变量。

## 数据库升级与回滚

先使用 SQLite 在线备份生成一致副本。回滚演练只允许操作副本：

```powershell
npm run test:e2ee:db-rollback -- --input=C:\path\to\voko-backup.db
```

命令在临时目录中升级副本、执行 `PRAGMA integrity_check`、用原始副本覆盖并再次打开；
不会修改输入备份或正在运行的数据库。真实回滚前必须停止 VOKO，并保留原库、WAL 和
SHM 文件，禁止直接在运行中的数据库上覆盖。

## 发布判定与故障处理

发布前运行 `npm run test:ci`、`npm run security:local`、
`npm audit --omit=dev --audit-level=high` 和 `npm pack --dry-run`。只有提交、推送及远端
状态满足要求后才能运行 `npm run release:preflight`。

发现失败时：立即全局关闭；禁止重放 `provider_accepted` 或 `outcome_unknown` 消息；
保存脱敏 runId、提交号、平台、门禁状态和密文命中数量；撤销受影响设备；修复后使用
新设备身份和新会话重新验收。重新开启必须是人工操作，不能由恢复脚本自动完成。

4 小时稳定性、macOS 真机、独立 Witness 和外部安全审计仍是扩大或正式发布门禁；
未完成时必须保持 `pending`，不得因内部 Canary 通过而降低要求。

## 附件 Canary

先运行不联网的故障闭环：

```powershell
npm run test:e2ee:attachment:fake
```

它验证分块 AEAD、固定密文重试、500、超时、存储服务重启、逆序下载、篡改拒绝和
服务端明文扫描。真实 OSS 必须使用专用的私有测试 Bucket，严禁复用生产 Bucket：

```powershell
$env:VOKO_E2EE_TEST_OSS_ACKNOWLEDGE_DEDICATED='1'
$env:VOKO_E2EE_TEST_OSS_REGION='<test-region>'
$env:VOKO_E2EE_TEST_OSS_BUCKET='<dedicated-test-bucket>'
$env:VOKO_E2EE_TEST_OSS_ACCESS_KEY_ID='<test-only-key-id>'
$env:VOKO_E2EE_TEST_OSS_ACCESS_KEY_SECRET='<test-only-secret>'
npm run test:e2ee:attachment:real
```

凭证只能授予该测试 Bucket 的最小 PUT/GET 权限，不得提交到 Git。Windows 和 Ubuntu
必须分别生成报告。三个附件门禁全部通过前，不能把附件接入限定账号内部 Canary。
