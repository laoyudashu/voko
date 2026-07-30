# Contributing

Issues and pull requests are welcome.

## Before opening a pull request

1. Create a focused branch from `main`.
2. Do not include credentials, personal data, generated databases, or private service configuration.
3. Add or update tests for behavior changes.
4. Run:

```bash
npm ci
npm test
npm run package:build
npm pack --dry-run
```

All user-visible strings in `src` must use the existing i18n system. Chinese and English keys must remain aligned.

Unless explicitly marked otherwise, submitted contributions are licensed under Apache-2.0 as described in section 5 of the license.
