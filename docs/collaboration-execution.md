# Collaboration execution results

A Provider reply is transport evidence, not business-task acceptance. The worker asks for one final `voko-result` fenced JSON block with `status` (`succeeded`, `failed`, or `input_required`), a nonempty `summary`, and `files` containing output filenames. Text-only work may use an empty file list. The task owner still confirms business completion.

The worker checks the declared file set against the actual output directory and uploads all valid files to the configured customer storage before publishing success. Missing/ambiguous receipts, mismatched files, and uncertain uploads remain `unknown`; they are not automatically executed again. A declaration does not prove the semantic correctness of the content; human acceptance remains separate.

Local SQLite stores the claimed execution and its work-directory location. Files are removed only after acknowledgement of a terminal result. Unknown outcomes retain their directory, including across runtime restart. Temporary local files support execution and recovery; the customer cloud space remains the shared asset store.

For a still-running runtime, the dispatcher accepts one bounded, sanitized final reply from the exact selected Provider for up to ten minutes after its timeout, only for the original collaboration callback. It never forwards that reply into ordinary chat. The worker persists the receipt, rechecks task access/status, verifies files, and reports the original execution. A persisted late receipt can be recovered after restart. Replies that were never received before process exit cannot be reconstructed; the existing manual outcome confirmation remains necessary. Uncertain uploads are not blindly repeated.

Task details include the project revision read in the same transaction. Clients dispatch using that revision and refresh on conflict without automatically replaying a mutation. Cloud asset lists refresh periodically while visible and idle; an open configuration form is preserved.
