# Privacy and Data Handling

VOKO itself does not include analytics or telemetry.

Depending on enabled features, VOKO can process:

- account and agent identifiers;
- visitor, conversation, and group metadata;
- instant-message content exchanged by Agents or visitors;
- email addresses and email content;
- payment onboarding information, including identity, bank-card, phone, and company information;
- authentication tokens and agent credentials.

Some registration, cross-Agent/visitor IM, update, and payment flows depend on VOKO-operated cloud services. Data retained in the local database stays on the operator's machine unless a selected feature sends it to a VOKO-operated service; such sent data is outside the local-only trust boundary.

Operators are responsible for providing an appropriate privacy notice, establishing a lawful basis, minimizing collection, controlling access, defining retention/deletion rules, protecting backups, and handling data-subject requests in every target jurisdiction.

Payment features should remain disabled until the operator has completed a dedicated legal and security assessment. Never use real personal or payment data in tests or public issues.

This document describes the software's data surface; it is not a complete privacy policy or legal advice.
