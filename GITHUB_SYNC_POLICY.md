# GitHub Sync Policy

This repository is the source candidate for the public VOKO Lite project. Review the exact Git index before every GitHub push.

## Files that may be synchronized

- application source under `src/`;
- repository automation under `.github/`;
- release and maintenance scripts under `scripts/`;
- `package.json`, `package-lock.json`, and `tsconfig.json`;
- public documentation, policies, notices, and license files;
- `.env.example`, `.gitignore`, and `.gitleaks.toml`.

Only synchronize these files after the release gate and secret scans pass.

## Files that must not be synchronized

- live credentials, tokens, passwords, signing keys, private certificates, or populated environment files;
- local npm configuration such as `.npmrc`;
- the local `test/` directory and internal regression fixtures;
- `voko.db`, any other SQLite database, and SQLite journal/WAL/SHM files;
- user messages, Agent records, payment or identity data, logs, runtime locks, PIDs, and staged updates;
- `node_modules/`, generated `build/` or `dist/` output, coverage output, caches, and temporary build directories;
- local audit output such as `audit-results/`, `scancode-results/`, `.ort/`, and generated SBOM files stored there;
- npm package archives, installers, native binaries, or unrelated Desktop application files;
- the history or files of any other VOKO repository.

Ignored files are not automatically safe: a file already tracked by Git remains tracked after it is added to `.gitignore`.

## Required pre-push review

Run these commands from this repository root:

```bash
git status --short
git diff --cached --name-status
npm run release:gate
npm pack --dry-run
gitleaks dir . --redact --config .gitleaks.toml
gitleaks git --redact --config .gitleaks.toml
```

Confirm that every indexed file belongs to the allowed list above. Do not use `git add -f` to override `.gitignore` for release artifacts or local data.

The default runtime database is named `voko.db`. It is application data and must never be committed or uploaded to GitHub.
