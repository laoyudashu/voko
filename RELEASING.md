# VOKO 发布流程

本流程适用于向 GitHub 推送代码，以及发布 GitHub Release 和 npm `@voko/lite`。任何门禁失败都必须停止，不采用“先发布、再修复”。当前保持人工发布，不启用自动 CD。

## 1. 首次准备本地安全工具

以下工具必须可从 `PATH` 调用：

- [Gitleaks](https://github.com/gitleaks/gitleaks)：扫描完整 Git 历史中的凭据。
- [CodeQL CLI](https://github.com/github/codeql-cli-binaries/releases)：建立 JavaScript/TypeScript 数据库并运行官方 `javascript-security-extended.qls` 查询集。

确认安装：

```powershell
gitleaks version
codeql version
```

CodeQL 数据库与 SARIF 分别写入 `.codeql-db/` 和 `.codeql-results/`，两者均已被 Git 忽略。本地与 GitHub 共用 `.github/codeql-config.yml`，排除构建产物、依赖、缓存和测试代码。`security:codeql` 遇到 security severity 不低于 7.0 的 high/critical 结果时失败，并打印规则、文件和行号。

## 2. 推送 GitHub 前检查

先完成代码审查并提交预期改动，确认位于 `main`，然后执行唯一入口：

```powershell
npm ci
npm run github:preflight
```

`github:preflight` 会依次检查：

1. 工作区干净且当前分支为 `main`；
2. 定向回归测试、国际化键一致性和 npm 包敏感信息扫描；
3. 生产依赖中不存在 high/critical npm audit 告警；
4. Gitleaks 完整历史扫描；
5. 本地 CodeQL extended 安全查询；
6. `npm pack --dry-run` 的发布包清单和构建过程。

门禁通过后才可推送：

```powershell
git push github main
```

推送后仍须等待 GitHub 上的 CI、Gitleaks、CodeQL 和依赖检查全部通过。本地检查是第一道门禁，GitHub Actions 是最终门禁；任一失败都不得创建 Release 或发布 npm。

## 3. 准备版本发布

1. 使用 SemVer 更新 `package.json` 与 `package-lock.json`，例如 `0.4.2`。
2. 更新 Release notes 或变更记录。
3. 提交版本改动，并按第 2 节完成推送及 GitHub 检查。
4. 在干净的 `main` 上执行：

```powershell
npm ci
npm run release:preflight
```

`release:preflight` 包含全部 GitHub 推送前门禁，并额外验证：

- `package.json` 与 `package-lock.json` 版本完全一致；
- 版本号符合 SemVer；
- 对应本地 Git Tag 尚不存在；
- 对应 npm 版本尚未发布，因为 npm 版本不可覆盖。

## 4. 人工发布 npm 与 GitHub Release

确认 npm 使用官方 Registry，Token 只通过本机环境变量和用户级 `.npmrc` 安全引用提供：

```powershell
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
```

npm 发布成功后，使用仅存在于本机环境变量中的 `OSS_ACCESS_KEY_ID` 和 `OSS_ACCESS_KEY_SECRET` 同步 `voko update` 的下载包与 manifest：

```powershell
npm run release:publish:update-source
```

更新源同步成功后，创建与 `package.json` 完全一致的 GitHub Tag 和 Release：

```powershell
gh release create vX.Y.Z --repo laoyudashu/voko --target main --title "VOKO vX.Y.Z" --generate-notes
```

预发布版本使用 SemVer 后缀（如 `0.5.0-rc.1`）、npm dist-tag（如 `--tag next`）和 `gh release create --prerelease`，不得覆盖正式版的 `latest`。

## 5. 发布后验证

拉取最新 Tag 后运行：

```powershell
git fetch github --tags
npm run release:verify
npm view @voko/lite@X.Y.Z version license repository.url --json --registry=https://registry.npmjs.org/
```

最终核对以下内容完全一致：

- `package.json` 和 `package-lock.json` 版本；
- npm 已发布版本；
- `voko update` 使用的 OSS manifest 与 tarball；
- `vX.Y.Z` Git Tag；
- GitHub Release 标题、目标提交及说明。

记录 GitHub Release URL、npm 版本、提交 SHA、发布时间及门禁结果。发布后发现问题时必须修复并递增版本，不能覆盖或复用已发布版本。

## 6. 凭据与产物边界

- 禁止把 Token 放进命令参数、源码、日志或聊天记录；`.npmrc` 只能引用环境变量。
- 发布包不得包含数据库、私钥、Token、日志、真实测试数据或临时目录。
- `.codeql-db/`、`.codeql-results/`、SBOM 和扫描报告均为本地产物，除非专门审查，否则不提交。
- OSS 发布凭据只允许使用环境变量提供，不得从本地运行数据库复制到发布脚本。
- GitHub Secret Scanning、Push Protection、Dependabot、CodeQL 和分支保护必须保持启用。
