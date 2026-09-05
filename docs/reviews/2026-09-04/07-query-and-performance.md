# S5 implementation and measurement report

Worktree: /Users/laoyu/Documents/ChatGPT/voko-opt-offline-20260904
Parent code checkpoint: 6f441eb (S3 on baseline a6e8f35).
Runtime: isolated Node22.23.2/npm11.19.0 on macOS arm64. No production service/account/network access. No dependencies, index/schema changes, cache, IO or cryptography changes.

## R17 / R15 implementation

Only list_conversations in src/mcp/tools.ts changes. A shared latest-visible-message relation is used by count and page queries. The needsReply filter therefore runs before count/limit/offset. Projection reuses the same visible summary; unread-count calculation remains timestamp-only, including the prior behavior of counting intercepted visitor messages later than the latest visible reply. Groups keep their stored summary/unread count and needsReply=false. Existing visible-message filters and timestamp DESC,rowid DESC tie-break remain. Empty rows retain lastIsMe=undefined. The outer ordering still uses conversations.last_timestamp and public pagination/filter parameters are unchanged.

This naturally removes per-row query preparation/calls: two relation queries, plus existing Agent/active-owner checks. SQL still performs indexed correlated lookups internally; do not describe it as a single table scan or guaranteed faster for every dataset.

### Validation

- Added test/list-conversations-query.test.js: four real SQLite behavior cases (first20 replied+21st pending; keyword/channel/owner; system/control/empty/ties/timestamp count; constant query calls for100 records). Initial old code: 0 pass/4 fail, /tmp/voko-s5-query-red.log.
- After fix: 4 cases pass. Existing group-mcp-tools executes its own 47 checks; 47 pass/0 fail. Combined Node test command reports5 top-level passes (4 new cases + group test file), /tmp/voko-s5-query-green-final.log.
- An initial green attempt had one assertion expecting three calls; instrumentation showed the unchanged ownership layer performs two queries (Agent lookup and active-owner lookup), so the correct bound is four. This test-count correction did not change production behavior.
- Additional list + unchanged provider-attachment tests: 11/11 pass, /tmp/voko-s5-targeted.log.
- `npm run build:ts`: exit0, /tmp/voko-s5-build.log. `npm run typecheck`: exit0, /tmp/voko-s5-typecheck.log. `git diff --check`: clean.

### Query measurement

Script /tmp/voko-s5-query-benchmark.cjs, 1000 synthetic private conversations, page100, all latest messages pending, 10 warm repetitions. 10k or100k messages. Both implementations return total1000/page100. Baseline and revised use the same data and no new index.

| messages | query calls before -> after (including 2 auth) | original build median ms | revised build median ms |
| --- | --- | --- | --- |
| 10,000 | 304 -> 4 | 3.675 | 3.410 |
| 100,000 | 304 -> 4 | 3.517 | 3.972 |

The small timing differences fluctuate; no broad speedup is claimed. The correctness fix and constant application query count are the verified benefits. Repeated baseline source measurement was4.897/3.742ms, illustrating noise. Existing indexes support the necessary access paths: idx_conversations_agent_channel and idx_messages_channel; page ordering still uses a temporary B-tree, as before. No evidence warrants adding an index in this batch.

Raw results: /tmp/voko-s5-query-before.jsonl, /tmp/voko-s5-query-after-final.jsonl. Exact old-source EXPLAIN repetition: /tmp/voko-s5-query-before-plan.jsonl using /tmp/voko-s5-baseline-query-loader.cjs. Revised count/page EXPLAIN uses indexed correlated lookups for latest/reply/pending counts, not an N+1 set of JS database calls.

## R14 measured baseline only

Script /tmp/voko-r14-attachment-benchmark.cjs. Each of8 matrix cells runs in a separate Node child process, 3 repetitions, synthetic10/25MiB file/Buffer, concurrency1/4 scheduled on the single event loop. Staging invokes real stageProviderAttachments; crypto invokes real encrypt+decryptE2eeV2Attachment roundtrip. No production code changed. Timer lag and monitorEventLoopDelay p95/max plus RSS samples are recorded. Promise concurrency serializes synchronous work as concurrent requests do on one Node event loop.

| path | MiB | concurrent | median elapsed ms | median timer lag ms | whole-process max RSS MiB |
| --- | --- | --- | --- | --- | --- |
| staging | 10 | 1 | 15.84 | 14.92 | 83.41 |
| staging | 10 | 4 | 61.03 | 60.13 | 108.22 |
| staging | 25 | 1 | 38.27 | 37.36 | 143.44 |
| staging | 25 | 4 | 143.13 | 142.20 | 173.42 |
| encrypt+decrypt | 10 | 1 | 19.67 | 18.79 | 142.28 |
| encrypt+decrypt | 10 | 4 | 79.54 | 78.68 | 286.55 |
| encrypt+decrypt | 25 | 1 | 47.21 | 46.31 | 237.02 |
| encrypt+decrypt | 25 | 4 | 200.57 | 199.89 | 549.08 |

All content integrity/roundtrip checks passed; staging checked directory0700/file0400 and cleanup after each result. Crypto permission checks are not applicable. MaxRSS includes fixture, crypto outputs and post-measurement verification; it is not an isolated function's peak allocation. Raw RSS before/after and event-loop metrics are in /tmp/voko-r14-{staging|crypto}-{10|25}-{1|4}.json. No message body/key/manifest is logged. Inputs, staged files and crypto buffers are synthetic; temporary directories are removed.

The measurements establish that larger simultaneous attachments can occupy the main event loop for roughly140-200ms on this machine. They do not establish production latency or justify a new stream cipher/worker architecture automatically. Keep R14 as measured/deferred product change. A future proposal can first examine removing duplicate staging reads or bounding concurrent attachment work, with integrity/path/permission guarantees preserved, before proposing larger cryptography changes.

## Integration / review boundaries

S5 commit should include only src/mcp/tools.ts and test/list-conversations-query.test.js. It has no S1 tools.ts helper changes; parent can cherry-pick alongside S1 with independent hunks. Parent must independently review the actual SQL diff and run the final integrated gate. Preserve R14 as benchmark-only; do not mark an IO/crypto fix completed. No full gate, deployment, publish, new dependency or user-data migration ran in this subtask.
