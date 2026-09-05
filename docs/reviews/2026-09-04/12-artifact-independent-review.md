# Independent R18 artifact scan review

Read exact commit292045f scanner, tests, full release workflow and author's report. Found a real fail-open scan defect on the local case-insensitive APFS filesystem: a tar containing `package/README.md` with a synthetic secret followed by safe `package/readme.md` was extracted with overwrite; both names then read the safe file, yielding filesScanned2/findings[]. A control archive with only the secret member was detected.

Evidence: /tmp/voko-s6-casecollision-probe.cjs and /tmp/voko-s6-casecollision-probe.log. Probes used hand-built ustar entries and an owned temporary directory, never user files. Scanner was copied directly from git to /tmp/voko-s6-review-scanner.cjs.

Further filesystem probes proved that NFC+lowercase alone is insufficient: APFS aliases ß/ss, final sigma/ordinary sigma, and the ff ligature/ff even though the lowercased strings differ. Recommended a small filesystem-identity safeguard rather than implementing a Unicode casefold/archive framework.

Follow-up a6f46a0 adds both portable NFC+lowercase path collision rejection and a final extracted regular-file dev+ino uniqueness check. The latter fails closed when distinct archive paths map to the same actual file, even after private extraction has overwritten its contents. Hardlinks/symlinks were already forbidden before extraction. No data outside the private temporary root is affected. Scanning some earlier entries before detecting a later alias cannot produce success because the function throws and the CLI exits1.

Independently copied the exact amended scanner and tests from a6f46a0 to /tmp/voko-s6-independent-review and ran Node22 tests:16/16 pass, exit0; /tmp/voko-s6-independent-review-tests.log. The original case-collision probe now rejects the archive before extraction; /tmp/voko-s6-casecollision-fixed.log records the rejection. Author's real ß/ss test is independently included in the16 tests and exercises this machine's aliasing branch.

Other inspected boundaries:
- Workflow packs once with --ignore-scripts, scans the filename from that npm pack result, uploads the same tgz and filename manifest, then publishes the downloaded filename. No second pack or mutable build scan is substituted for artifact bytes.
- Compressed snapshot SHA256 is computed from exactly the bytes expanded and scanned; post-pack source-tree edits do not affect it.
- Private extraction accepts only package-relative regular files/directories, rejects dot/parent/backslash/control paths and duplicate aliases; excludes symlinks/hardlinks/devices.
- Budgets cover compressed/expanded bytes, logical member bytes, member count, tar listing output and tar subprocess duration. Errors do not dump tar stderr or matched secret content.
- Artifact text is recognized from content (UTF8 or UTF16 BOM) rather than a filename suffix. Binary/nondecodable members remain outside heuristic text scanning.
- Current local system tar is macOS bsdtar; no GNU gtar executable was found. GNU listing parsing is source-reviewed but not runtime-validated here. Windows filesystem/tar behavior remains unverified.

Verdict: no remaining blocking R18 issue found in the reviewed amended diff. Full integration/release gate and platform boundaries remain parent's responsibility. No workflow was triggered, no package published, no source file changed by this reviewer.
