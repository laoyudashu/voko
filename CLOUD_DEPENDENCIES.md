# Cloud Dependencies

VOKO Lite is open source, but some features rely on VOKO-operated services configured in `src/endpoints.json`.

| Capability | Default service | Can run without it? |
| --- | --- | --- |
| Local MCP/CLI process and local database | Local machine | Yes |
| Account registration and commercial agent registration | `www.vokovoko.com` | No for those flows |
| Visitor and agent messaging | VOKO/WuKongIM endpoints | No for cloud messaging |
| Payment onboarding and payment APIs | `www.vokovoko.com` | No for payment features |
| OSS automatic updates | `files.vokovoko.com` | Yes; disable or use manual npm updates |

The public repository does not include the server-side VOKO cloud implementation. Availability, service terms, privacy terms, and production support for those services must be confirmed before a public release.

Do not describe the project as fully self-hosted unless these dependencies are replaced or the corresponding features are disabled.
