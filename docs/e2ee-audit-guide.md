# VOKO E2EE external review guide

Visitor-private-chat E2EE is now a production data path; groups, A2A, REST/Webhook, MCP/CLI, email, and payment remain outside that claim. No independent external audit is claimed yet. An external review must use an exact Git commit and must not review a copied subset without checking the manifest hashes.

Generate the review inventory from a clean worktree:

```bash
npm run e2ee:audit:prepare -- --output=e2ee-audit-bundle.json
```

The JSON records the commit, pinned OpenMLS/Rust versions, every tracked E2EE source and gate file hash, unresolved release gates, security claim, and explicit exclusions. Provide it together with the repository commit to the reviewer. The manifest is an inventory, not an audit result or a signature from the reviewer.

The production-scope review must cover at least credential/DID binding, KeyPackage replay, MLS establishment ordering, authenticated routing, atomic state and Outbox recovery, Vault and rollback protection, device recovery/revocation, private-chat attachment streaming, browser code trust, and the explicit plaintext endpoint boundary. Group metadata, optional A2A extensions, and Witness split-view handling are research/deferred scope and must not be mistaken for current production capability.

Findings need a stable identifier, severity, affected commit/path, reproduction, remediation commit and retest result. `external_security_audit` remains `pending_external` in `e2ee/release-gates.json` until all release-blocking findings are closed and the independent reviewer supplies a final report. VOKO developers must not mark their own internal review as this gate.
