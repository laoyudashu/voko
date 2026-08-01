# Contributing

Issues and pull requests are welcome.

The most useful contributions are Provider adapters, reproducible Provider compatibility reports, MCP contract improvements, and Windows/Linux/macOS validation.

## Before opening a pull request

1. Create a focused branch from `main`.
2. Do not include credentials, personal data, generated databases, or private service configuration.
3. Describe the validation performed for every behavior change. The repository intentionally does not publish its local `test/` directory, so maintainers run the internal regression suite before release.
4. Run the checks available in your checkout:

```bash
npm ci
npm run package:build
npm pack --dry-run
```

For a Provider compatibility report, include the VOKO version, operating system/version, Provider version, connection mode, safe reproduction steps, and any non-sensitive logs.

All user-visible strings in `src` must use the existing i18n system. Chinese and English keys must remain aligned.

Unless explicitly marked otherwise, submitted contributions are licensed under Apache-2.0 as described in section 5 of the license.
