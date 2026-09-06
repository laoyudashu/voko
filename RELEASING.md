# VOKO 发布流程

代码和版本通过 PR 进入 GitHub `main`。发布由人工触发 GitHub Actions 的 **Publish npm**，通过受保护环境审批后使用 npm Trusted Publisher/OIDC 发布。普通 push/PR 不触发 CD，不从开发机直接发布 npm。

工作流以 [.github/workflows/release-npm.yml](.github/workflows/release-npm.yml) 为准；逐项核对 [发布清单](RELEASE_CHECKLIST.md)。任何发布门禁失败都应先解决，不能跳过检查发布。

## 1. 准备版本 PR

从准备发布的代码建立 `codex/` 分支，更新 `package.json`、`package-lock.json` 顶层及根包版本、中英文 README、`CHANGELOG.md` 和 `docs/releases/X.Y.Z.md`。尚未发布时明确标为发布准备，不声称 npm 已可安装该版本。

在版本分支执行：

```sh
npm ci
npm run release:gate
npm run test:e2e
npm run security:local
npm pack --dry-run
```

`release:gate` 包含类型检查、构建、国际化检查、完整测试与覆盖率门槛、包密钥扫描和生产依赖审计。`security:local` 需要 PATH 中的 Gitleaks 和 CodeQL CLI，扫描完整 Git 历史及 JavaScript/TypeScript extended 安全查询；报告保存在被忽略的 `.codeql-db/` 和 `.codeql-results/`。

提交并推送该分支，创建目标为 `main` 的 PR。等待三系统 Node 22、Chromium E2E、Rust E2EE、security/SBOM、dependency review 和 CodeQL 检查。不要直接推送 GitHub main。

`github:preflight` / `release:preflight` 的状态检查要求 `main`，不能作为版本分支入口，也不应为了运行它们跳过 PR 流程。

## 2. 合并后的发布前检查

PR 审查并合并后，等待 main 的 Node 22/24 三系统和完整浏览器矩阵等检查。同步本地 main，确认工作区干净、HEAD 与 `github/main` 一致，再执行：

```sh
npm ci
npm run release:preflight
```

此入口额外确认版本字段一致、GitHub main 同步，以及本地 tag 和 npm 版本未占用。不要复用已发布版本。

## 3. 人工触发受保护发布

1. 确认 `@voko/lite` 将本仓库的 `release-npm.yml` 配置为 npm Trusted Publisher，`npm-production` 环境的审批设置正确。
2. 从 main 启动 **Publish npm**，输入与源码完全一致的版本，例如 `0.5.3`。稳定版必须设置 `prerelease=false`，该输入默认是 true。
3. `prepare` 在 Node 24 上运行 release gate、Chromium E2E，打包并扫描确切 tarball，上传不可变 artifact。
4. 审查产物和检查结果后审批 `npm-production`。发布 job 使用短期 OIDC 身份，以 `--access public --provenance` 发布同一 tarball，不需要长期 npm Token。
5. npm 版本回读成功后，后置 job 才在本次 workflow 的确切 SHA 创建 `vX.Y.Z` 和 GitHub Release。不要提前创建同名 tag/Release，工作流拒绝覆盖。

注意：当前 `prerelease` 输入仅控制 GitHub Release 标记；npm 发布命令未设置 `--tag next`，不能将此开关视为 npm 预发布渠道。本流程用于稳定版本；若要发布 SemVer 预发布包，应先独立调整和验证 dist-tag 流程。

升级发现、安装和发布验证均使用官方 npm registry，不再同步 OSS manifest，也不需要 OSS 发布凭据。不要使用已移除的 `release:publish:update-source` 命令。

## 4. 发布后验证

在已发布源码 checkout 拉取 tag 后运行：

```sh
git fetch github --tags
npm run release:verify
npm view @voko/lite@0.5.3 version license repository.url --json --registry=https://registry.npmjs.org/
```

版本示例应替换为本次发布版本。核对 package/lock、npm 版本与 provenance、tag 目标 SHA、GitHub Release 及 `voko update` 发现结果。记录 Actions、npm、Release 链接、SHA、发布时间和门禁结果。

工作流生成 GitHub Release 正文；将审核过的版本说明、已知限制和验证链接补入正文，并通过文档 PR 更新源码内的发布状态与日期。

若 npm 发布成功而后置 tag/Release 步骤失败，先核对 registry 和原 workflow SHA，再只恢复缺失的后置步骤；不要重新发布同一个 npm 版本或将 tag 指向后来移动的 main。

## 5. 凭据与产物边界

- 不把凭据放入源码、命令参数、日志或聊天；不从运行数据库复制发布凭据。
- 发布包不得包含数据库、私钥、Token、用户日志或临时测试目录。
- 本地 CodeQL 数据库、SARIF 和临时产物不提交；工作流生成的 SBOM 按其 artifact 流程保留。
- 保持分支保护、CodeQL、依赖审查及仓库可用的 secret scanning/push protection 设置；这些管理设置不能仅凭测试通过推定已配置。
