# Muse MSP fixtures

Captured on Linux on 2026-09-29 from Muse Code **1.4.1 (1.4.1-R4503.1)**,
build `35815c253477406321e3f5595195becc25e3907a`.

- Stable handshake fingerprint: `sha256:e0e163db6ccf00dbe68402ce55d6319b3edc33c421f31e9583b587b2de8a118f`.
- Experimental export fingerprint: `sha256:b359d70b581b0ea471d35a7770d3039fdd35f19a46a2d42b43fd4b1674d52c8a`.
- Schema version: `1`. Both `sessionMcp` and `sessionListStream` were granted.

Each line is `{ "dir": "out" | "in", "msg": <JSON-RPC message> }`.
`out` means client to host; `in` means host to client. IDs, timestamps, cursors,
revisions, deltas, and event order are retained. Replay consumers should treat IDs
and cursors as opaque and compare behavior rather than wall-clock values.
The skill catalogs retain only the test selectors `phase0` and `muse-parity-*`; unrelated personal,
bundled, and installed-plugin skill rows were removed. No credentials are included.

A throwaway driver launched `muse serve` with isolated `XDG_CONFIG_HOME` and
`XDG_DATA_HOME`. Model turns used a custom Responses endpoint, an environment key,
`providerId: "meta"`, and `modelId: "meta/muse-spark-1.3"`. The settings pinned the
endpoint's `auth: "bearer"`, the default provider/model, and permission profile
`:ask-me` with its own `schema_version: 1`. The sandbox and default `proxy-only`
network policy remained enabled. Workspace trust was enabled for project skills.
The approval judge was disabled for staged approval probes so decisions reached
the client. The driver and local server remain outside the repository.

| File                             | Recorded behavior                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text-reasoning.ndjson`          | Session start, rational-sum prompt, public reasoning summary, streamed assistant text, token usage, terminal.                                                                          |
| `tools-edit.ndjson`              | Read `f`, run `wc -l f`, replace `beta` with `gamma`; fetch the JSON patch through `patchRef` and `item/readOutput`.                                                                   |
| `staged-approval.ndjson`         | `wc -l f && rm -rf f`: safe first stage, held second stage, receipt and decision, terminal resolution. Also records a duplicate decision rejected as already resolved.                 |
| `multi-stage-approval.ndjson`    | `wc -l f && rm -rf f && rm -rf g`: successive decisions return `terminal: false`, then `true`; both files are removed.                                                                 |
| `interrupt.ndjson`               | Interrupt a running shell sleep; tool reconciliation and `turn/completed` with `terminal: "cancelled"`.                                                                                |
| `steer.ndjson`                   | Submit `ifBusy: "steer"` during a shell sleep; accepted as `steered`, and the original turn replies with the replacement marker.                                                       |
| `resume-source.ndjson`           | Complete a marker turn, then kill the host process before starting either resume probe.                                                                                                |
| `resume-without-cursor.ndjson`   | New host returns inline history and runs a fresh turn recalling the marker.                                                                                                            |
| `resume-with-cursor.ndjson`      | New host returns `history.mode: "none"`, replays the cursor suffix, then completes a fresh marker turn.                                                                                |
| `resume-reasoning.ndjson`        | New host resumes the steering session, including its reasoning history, and completes another text turn.                                                                               |
| `subagent.ndjson`                | Native spawn/wait/read-result tool calls return a child result marker and an evidence log path. This build emits `toolCall`, without a dedicated `subagent` item.                      |
| `skill.ndjson`                   | Discover the project skill and invoke its selector through a structured skill input part.                                                                                              |
| `image-followup.ndjson`          | Send a valid 16×16 PNG, then complete a text-only marker turn in the same session. Image-description accuracy is not asserted.                                                         |
| `catalog-controls.ndjson`        | Model catalog, environment-key account state, empty subscription usage, paginated sessions, approval mode change, valid model selection, and rejection of a model outside the catalog. |
| `mcp-stdio.ndjson`               | Admit a session-scoped stdio server. Model attempts fail with an unknown-tool routing error and no marker is returned; this is a failure fixture.                                      |
| `auto-review-unavailable.ndjson` | Selecting `:auto-review` as the default profile rejects session start because the automated reviewer is unavailable.                                                                   |
| `unsafe-path.ndjson`             | Group-writable data directory rejects session start with `UnsafePath`.                                                                                                                 |
| `initialize-history.ndjson`      | Handshake against 322 retained session logs (7,713,541 bytes); three measured launches took 155–160 ms.                                                                                |

The project skill body was “Reply with exactly SKILL_PHASE0_OK. Do not use tools.”
The injected stdio server implemented `initialize`, `tools/list`, and `tools/call`,
advertised `verification_echo` with an empty-object input schema, and returned
`MCP_PHASE0_OK` as text. The host registered `mcp__verification__verification_echo`,
but the model route attempted the unqualified `verification_echo`; the marker
was never delivered. Keep this distinction when testing MCP support.

Phase 3 captures use the same build and isolated custom route. Sandbox and network
remain at their defaults. `phase3-user-skill` omits workspace trust;
`phase3-project-skill` enables it. Native subagent captures enable
`MUSE_EXPERIMENTAL_SDK_ENABLED=on`; the default workflow capture reads the session
from a daemon run that omitted the flag. Its workflow child IDs are internal
activity IDs, not MSP `childSessionId` values.

| File                             | Recorded behavior                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `phase3-controls.ndjson`         | Two todo entries, a single-choice question, an answer and matching settlement, retained view paging, empty subscription usage.       |
| `phase3-cancel.ndjson`           | Question cancellation and matching cancelled settlement.                                                                             |
| `phase3-child-read.ndjson`       | Read and page an actual native child session, returning its assistant marker.                                                        |
| `phase3-default-workflow.ndjson` | Read and page the default daemon run: workflow revisions 1–7, child activity, and `MUSE_PARITY_CHILD_OK`; no `childSessionId`.       |
| `phase3-user-skill.ndjson`       | User-scoped skill catalog and structured invocation, returning `MUSE_PARITY_USER_OK` with trust off.                                 |
| `phase3-project-skill.ndjson`    | Project-scoped skill catalog and invocation, returning `MUSE_PARITY_PROJECT_OK` with trust on.                                       |
| `phase3-compact.ndjson`          | Resume a completed session; manual compaction rejects with `compaction_unavailable`.                                                 |
| `phase3-compact-history.ndjson`  | Resume three completed turns; catalog context limit is null and compaction still rejects.                                            |
| `phase3-compact-limit.ndjson`    | Same session and route with only a configured context limit; compaction is admitted and completes, reducing 22,192 tokens to 21,322. |

The subprocess fixture host also generates schema-based variants for dedicated
subagent items, explicit child-session linkage, nonempty subscription windows,
`skill/changed`, deny choices, lost events, watchdog silence, and late admission.
These variants test protocol behavior; they are not claimed as real-host captures.
The workflow replay triggers a generated gap to page the recorded default run.
Disk edits in a live host did not emit `skill/changed` during a 15-second probe.
