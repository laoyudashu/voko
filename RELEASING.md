# VOKO 发布流程

本流程适用于 GitHub Release 与 npm `@voko/lite` 发布。任何一个门禁失败，都停止发布，不用“先发出去再修”。

## 1. 本地门禁

在发布提交所在的干净工作区执行：

```powershell
git status --short
npm ci
npm run release:preflight
```

`git status --short` 必须无输出。`release:preflight` 会运行测试、国际化检查、npm audit、发布包密钥扫描、构建和 `npm pack --dry-run`。

发布包必须不包含数据库、Token、私钥、日志、测试凭据或临时目录。

## 2. Gitleaks 与 GitHub 安全门禁

`.github/workflows/ci.yml` 的 `security` Job 使用 Gitleaks 扫描完整 Git 历史，并运行 npm audit 与 SBOM 生成。它会在每次 push 和 Pull Request 中执行；GitHub Secret Scanning、Push Protection 和私密漏洞报告也必须保持启用。

推送后，必须等待对应 `main` 检查完成，并确认 CI、Gitleaks、CodeQL、依赖审查没有失败。检查未完成或有失败时，不创建 GitHub Release，不发布 npm。

如果本机安装了 Gitleaks，可在提交前额外执行：

```powershell
gitleaks git --redact --verbose
```

## 3. 推送与 GitHub Release

```powershell
git push github main
```

确认 GitHub Actions 全部通过后，再创建匹配版本的 tag 和 Release：

```powershell
gh release create vX.Y.Z --repo laoyudashu/voko --target main --title "VOKO vX.Y.Z" --generate-notes
```

预览版本使用 `--prerelease`。版本号必须与 `package.json` 一致。

## 4. npm 发布

使用官方 Registry。Token 只通过本机环境变量和 `.npmrc` 引用提供，禁止放入命令参数、源码、日志或聊天消息：

```powershell
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
npm view @voko/lite@X.Y.Z version license repository.url --json --registry=https://registry.npmjs.org/
```

发布前确认版本尚未存在；npm 版本不可覆盖。若发布后出现异常，修复后必须递增版本号，不要尝试覆盖或随意撤包。

## 5. 发布后记录

记录 GitHub Release URL、npm 版本、提交 SHA、发布时间和门禁结果。发布完成后再次确认工作区干净，并将必要的兼容性或迁移说明补充到 CHANGELOG 或 Release notes。
