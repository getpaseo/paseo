# PandaOS consolidation acceptance

Kitchen is external and Apache-2.0 licensed at [paseo-kitchen](https://github.com/marushan491/paseo-kitchen). Dashboard remains a separate private plugin. The [plugin delivery](../plugin-first/current-core-proof.json) and [migration boundaries](../../team-runtime.md) apply.

## Verified

- Integrated web UI on source `4f8197f9c`, own daemon/home on ports 4033/4133; Mac tunnel `http://localhost:3033` returns HTTP 200 from the Mac. No paid provider turns or production restart.
- Pairing UI locks admission, unlocks it, removes the owned fixture device, and persists its revocation. See `pairing-proof.json` and paired-device screenshots.
- Kitchen loads through its registered Sidebar contribution and renders the job form. The raw Kitchen recipe reports pass, but its Sidebar goal did not perform the intermediate reorder/hide actions; it proves only the final visible configuration. Earlier complete Kitchen dispatch, repair and acceptance evidence belongs to the standalone plugin delivery.
- Dashboard renders the actual failed missing-directory schedule. An explicit Snooze click persists one snooze. Its combined recipe later stops at an uncertain automation goal; that failure is retained in the report. Separate explicit Done and Reopen recipes pass, and `dashboard-proof.json` verifies that the native workspace completion mark remains null.
- Asynchronous questions: two questions render, the real tool dismisses only the obsolete one, and reload retains the other. Expanded history displays the persisted dismissal reason; that screenshot followed manual debugging of an uncertain history-expansion recipe. The routing notice is a controlled real-manager fixture, not evidence of live account recovery. See `questions-proof.json`.
- Independent targeted routing, pairing, browser and question checks: 384, 48, 57 and 12 passing cases before integration. Integrated checks cover shared pairing/auth and profile import. CI regression fixes cover omitted optional routing notices, immediate authenticated Hub bootstrap and generated device credentials.

## Limits

The isolated macOS Electron fixture cannot access its Keychain noninteractively and fails closed before writing credentials. Successful macOS profile persistence and portable backup restore remain unverified; see `mac-profile-result.json`. Native iOS/Android appearance and real quota/account fallback are unverified. Saved Mac-only hosts produce connection diagnostics when this web recipe runs on Linux; the owned QA host is connected.

Final GitHub CI results are attached to the consolidation pull request. CI is the broad-suite verification; no full suite was run locally. Later commits fix shared server regressions and CI assertions without changing this rendered UI. Native teams are not automatically migrated; finish their active jobs with the existing daemon before rollout.
