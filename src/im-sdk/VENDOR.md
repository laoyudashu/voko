# VokoIMSDK vendored runtime

The files in this directory are the runtime portion of `D:\kimi_code\VokoIMSDK`.

- Upstream commit: `6719100` (`feat: harden IM delivery reliability`)
- Vendored on: 2026-08-02
- Purpose: shared in-process WuKongIM Hub transport for VOKO

Local integration code belongs in `src/core`; protocol changes should be made in
the upstream VokoIMSDK repository first and then vendored here with this marker
updated to the new commit.
