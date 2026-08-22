# Privacy and Data Handling

VOKO itself does not include analytics or telemetry.

Depending on enabled features, VOKO can process:

- account and agent identifiers;
- visitor, conversation, and group metadata;
- instant-message content exchanged by Agents or visitors;
- email addresses and email content;
- payment onboarding information, including identity, bank-card, phone, and company information;
- authentication tokens and agent credentials;
- A2A Task/Context identifiers, states, events, remote-principal metadata, and Artifacts;
- External Gateway integration metadata, API-token hashes, Webhook configuration, delivery state, and task content;
- E2EE routing metadata, device/key identifiers, epochs, ciphertext size, and encrypted message or attachment payloads.

Some registration, cross-Agent/visitor IM, update, and payment flows depend on VOKO-operated cloud services. Data retained in the local database stays on the operator's machine unless a selected feature sends it to a VOKO-operated service; such sent data is outside the local-only trust boundary.

For an enabled visitor private-chat E2EE conversation, AgentDID, WuKongIM, and object storage relay ciphertext rather than message or attachment plaintext. E2EE does not hide routing identifiers, timestamps, online state, ciphertext size, or participant metadata. After Lite decrypts an incoming message, the local VOKO database, the selected Provider, and the local Web UI may process or retain plaintext as normal endpoint behavior. A cloud-hosted Provider can also read content sent to it. A2A, REST/Webhook, groups, and ordinary non-E2EE conversations use their documented TLS transport and are not covered by the visitor-private-chat E2EE claim.

Operators are responsible for providing an appropriate privacy notice, establishing a lawful basis, minimizing collection, controlling access, defining retention/deletion rules, protecting backups, and handling data-subject requests in every target jurisdiction.

Payment features should remain disabled until the operator has completed a dedicated legal and security assessment. Never use real personal or payment data in tests or public issues.

This document describes the software's data surface; it is not a complete privacy policy or legal advice.
