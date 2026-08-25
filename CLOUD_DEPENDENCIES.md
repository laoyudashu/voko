# Cloud Dependencies

VOKO Lite is open source, but some features rely on VOKO-operated services configured in `src/endpoints.json`.

| Capability | Default service | Can run without it? |
| --- | --- | --- |
| Local MCP/CLI process and local database | Local machine | Yes |
| Account registration and commercial agent registration | `www.vokovoko.com` | No for those flows |
| Cross-Agent and visitor instant messaging (IM) | VOKO/WuKongIM endpoints | No for cloud messaging |
| Public A2A 1.0 Card, Task mailbox, and remote-Agent relay | VOKO AgentDID endpoints | No for public A2A Gateway |
| External REST ingestion and Webhook delivery | VOKO AgentDID endpoints | No for External Gateway |
| E2EE public-key directory and ciphertext relay | VOKO AgentDID/WuKongIM endpoints | No for visitor private-chat E2EE; ordinary plaintext chat remains available |
| Temporary private-object upload authorization | VOKO AgentDID and configured OSS | No for cloud attachments |
| Payment onboarding and payment APIs | `www.vokovoko.com` | No for payment features |
| OSS automatic updates | `files.vokovoko.com` | Yes; disable or use manual npm updates |

The public repository does not include the server-side VOKO cloud implementation. Availability, service terms, privacy terms, and production support for those services must be confirmed before a public release.

Do not describe the project as fully self-hosted unless these dependencies are replaced or the corresponding features are disabled.

The local runtime, local database, MCP, CLI, and local Web UI can run on the operator's machine. Registration, cloud-backed Agent IM, A2A, External Gateway, E2EE directory/relay, attachments, email, and payment capabilities cross the VOKO-operated service boundary. In an E2EE visitor private chat, those relay services transport ciphertext; local Lite and the selected Provider remain plaintext endpoints.
