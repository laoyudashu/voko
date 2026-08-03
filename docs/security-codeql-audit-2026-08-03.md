# CodeQL 高危告警审计（2026-08-03）

本记录覆盖本地 CodeQL `javascript-security-extended` 查询集最初报告的 21 项 high/critical 告警。结论为：**10 项真实风险已修复，11 项经代码边界与回归测试确认属于误报**。

## 审计结论

| 规则/位置 | 原始数量 | 结论 | 处理与依据 |
| --- | ---: | --- | --- |
| Reflected XSS（Web 首页、群聊页） | 6 | 真实风险 | 新增统一的 inline-script JSON 序列化，转义 HTML/script 边界字符；查询参数先做白名单或 URL 编码。回归测试覆盖 `</script>`、HTML 标签及 Unicode 行分隔符。 |
| File-system race（Aider 历史、OpenClaw 配置、Gateway 配置复制） | 3 | 真实风险 | 改为文件描述符权限收紧、读取后检查，以及 `COPYFILE_EXCL` 原子复制，消除 check-then-use 窗口。 |
| Insecure temporary file（本地附件上传） | 1 | 真实风险 | 使用系统临时目录下的私有随机目录，文件以 `wx` 和 `0600` 创建，并在成功或失败后递归清理精确目录。 |
| Path injection（Agent 工作区读写） | 4 | 误报 | `resolveContainedFile` 拒绝绝对路径和 NUL，使用 `realpath` 验证工作区、真实文件或真实父目录，并拒绝写入现存符号链接。测试覆盖遍历、绝对路径、symlink/junction 逃逸。 |
| Remote property injection（Cookie 解析） | 1 | 误报 | 结果对象使用 null prototype，并拒绝 `__proto__`、`prototype`、`constructor`；动态键不能修改对象原型链。 |
| User-controlled bypass（OpenClaw challenge） | 2 | 误报 | 该条件是协议事件分派，不是授权判断；消息类型和事件名精确匹配，nonce 限制类型、非空和最大长度，私钥及认证令牌不受远端控制。 |
| User-controlled bypass（本机 Host 校验） | 1 | 误报 | 被标记的函数本身就是 allowlist，仅接受 `localhost`、`127.0.0.1`、`::1`，并拒绝 URL 凭据及额外路径、查询、fragment。 |
| User-controlled bypass（注册状态机） | 1 | 误报 | `action` 只负责路由到状态机步骤；验证码步骤仍校验服务端签发的 registrationId、验证码及会话状态。 |
| User-controlled bypass（登录发码/验码） | 2 | 误报 | 两个条件是 POST action 分派；实际发码限流及 OTP 权威验证均在服务端 handler 内执行。 |

## 排除规则

误报不按目录、文件或整个查询规则进行宽泛排除。`.github/codeql-allowlist.json` 对每条当前结果记录：

- CodeQL rule ID；
- 精确源文件；
- SARIF 代码行哈希与列指纹；
- 可审计的排除理由。

`npm run security:codeql` 同时执行两项约束：

1. 任何未匹配 allowlist 的 high/critical 告警都会失败；
2. 任何因代码变化而失效的 allowlist 指纹也会失败，要求重新审计或删除。

因此，排除项不能静默覆盖同文件中的新漏洞，也不能在相关代码变化后继续沿用旧结论。

## 验证范围

- `test/web-security-regressions.test.js`
- `test/agent-file-security.test.js`
- Provider IPC/生命周期相关定向测试
- 注册状态机及 Web 登录定向测试
- TypeScript 构建、CodeQL extended 扫描、Gitleaks、npm audit 与发布包检查

该记录针对上述代码版本和数据流；后续指纹变化必须重新审计，不应仅更新哈希以绕过门禁。
