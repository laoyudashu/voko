# Independent S1 diff review

Reviewed exact commit c2db6b87b6df47d2f316d9895f586f523fa55719 from git, not an inferred current build. Reference source: locally installed @modelcontextprotocol/sdk/dist/cjs/types.js RequestIdSchema (line 142), string or integer schema. All probes use synthetic inputs, isolated SQLite, no open service/real network.

## Actionable finding: MCP request ID acceptance diverges from the installed protocol schema

The revised HTTP router accepts null and any finite numeric id. The SDK RequestIdSchema rejects null, fractions and unsafe integers. A source-transpiled real-router probe of the exact commit confirmed null and 0.5 each return 200 and invoke tools/call once even though SDK validation rejects the id. 0 and the empty string both remain valid and correctly correlate. Additional SDK checks reject Number.MAX_SAFE_INTEGER+1 and 1e100 (Number.isInteger would not be enough), while MAX_SAFE_INTEGER and -1 are accepted.

Fix minimally with RequestIdSchema.safeParse, or string / Number.isSafeInteger validation, rejecting invalid request ids before invoking methods. Preserve missing-id notification semantics and id=0/empty string. Amend tests which currently assert null is a valid request id. Do not replace transport or redesign SDK integration.

Evidence: /tmp/voko-s1-adversarial-probe.cjs and /tmp/voko-s1-adversarial-id.log.

## Other diff conclusions

- ACL removal derives owner/Agent/list type from the actual record, verifies owner before mutation, rejects supplied Agent/list mismatch, and passes SQL scope to the low-level remover. Both removeEntry call sites are updated. id-only owned calls and missing-record idempotence remain. Same-owner disable behavior aligns with the existing by-visitor path, so this is not a new generalized ACL layer. No new bypass found in the reviewed change.
- Friend approvals use exact trimmed positive commands; negative, quoted or mixed sentences no longer match. The id prefix/type boundary and existing idempotent whitelist check remain. No unnecessary intervention state-machine redesign.
- Credential scanning iterates every match; the private pattern inventory all uses global regex flags. Placeholder exceptions remain local to each match. Oversize input is rejected before normalization and user-rule access. Remaining short-input ReDoS is explicitly outside the partial length fix; no claim that it is solved.
- A2A point-directory denial plus path-relative containment prevents the demonstrated parent/root deletion computation. No live filesystem attack was performed; full Windows runtime validation remains a separate boundary.

## Independent verification

Loaded the exact changed source files from git under the existing dependency tree using /tmp/voko-s1-commit-loader.cjs. Ran the four commit test files (ACL, audit, HTTP id, A2A attachment workspace) copied to an isolated /tmp test tree: 40 tests passed, 0 failed, exit 0; /tmp/voko-s1-independent-tests.log. Their null-id acceptance test passes because it encodes the protocol misconception identified above. This is why the added adversarial SDK comparison is necessary.

No source file was modified for this review. Parent agent owns the minimal ID follow-up and integration verification.
