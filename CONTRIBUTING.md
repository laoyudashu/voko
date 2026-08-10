# Contributing

Issues and pull requests are welcome.

The most useful contributions are Provider adapters, reproducible Provider compatibility reports, MCP contract improvements, and Windows/Linux/macOS validation. Provider adapters included in this repository, including in-process adapters, are contributed under the project's GNU AGPL v3.0-only license. Independent programs that connect through MCP, CLI, HTTP, or another standard interface remain subject to their own licensing choices.

## Before opening a pull request

1. Create a focused branch from `main`.
2. Do not include credentials, personal data, generated databases, or private service configuration.
3. Describe the validation performed for every behavior change. Maintainers run the complete regression and security gates before release.
4. Run the checks available in your checkout:

```bash
npm ci
npm test
npm run package:build
npm pack --dry-run
```

For a Provider compatibility report, include the VOKO version, operating system/version, Provider version, connection mode, safe reproduction steps, and any non-sensitive logs.

Before implementing a new Provider adapter, follow [Add a new Agent Provider](docs/adding-provider.md). A Provider is not considered supported until its runtime resolution, registration readiness, Session isolation, delivery outcomes, fallback/recovery, security boundary, and real-device matrix have been validated.

All user-visible strings in `src` must use the existing i18n system. Chinese and English keys must remain aligned.

## Contribution terms

Code contributions require the confirmations in the pull-request template. By submitting a contribution, you accept [CONTRIBUTOR-TERMS.md](CONTRIBUTOR-TERMS.md): you retain your copyright, license the contribution under GNU AGPL v3.0-only, and grant the project the commercial re-licensing rights described there. Maintainers review these confirmations manually before merge.
