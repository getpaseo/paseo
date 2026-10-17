# Hermes ACP subagent QA

Second-pass verification uses actual Paseo provider, daemon, WebSocket and browser paths. The screenshots show the real app. Synthetic replies are labeled `[NO-MODEL FIXTURE]`; live-model results are recorded separately.

## Results

- Paseo focused tests: 166 passed across 5 files. This includes resume-only replay, opening history count/byte overflow and timeout, shortened/empty public-text replacement with a changed timeline epoch, titles and limit notices.
- Hermes ACP tests: 50 passed across 3 files. Blocking check runner: 11 checks passed, zero blocking/advisory health findings.
- Additional Hermes delegation tests: 75 passed, 1 failed. `test_child_dedicated_db_follows_parents_db_path` compares macOS `/var` and `/private/var` as strings. The same failure was verified on the unchanged base in the first pass; it is not a new failure introduced here.
- Plugin, server and app typechecks: exit 0. Changed-file lint: zero warnings/errors. Formatting check passed.
- Node no-model UI: 4 passed (25.4s). Companion Python no-model UI: 4 passed (50.3s). A further output-warning viewport capture passed (17.0s).
- Real authenticated model success UI: 1 passed (1.3m). Real-runtime failure injection UI: 1 passed. See the structured outcome files below for actual observations.

[Selected command result lines](validation-results.txt). Full repository success is not claimed.

## Real model observations

The producer was the modified Hermes checkout's real `AIAgent`, delegate tool and ACP server. The consumer was the modified Paseo checkout. Authentication used the official read-only Codex resolver. Credentials remained in memory; no credential files were copied. The runner writes only a temporary, separate Hermes home and synthetic workspace. Memory, context-file loading and background review are disabled for the QA parent. No installed runtime or personal profile configuration was edited.

Success used `openai-codex` / `gpt-6.1-sol`. The parent delegated counting three synthetic text files after a 40-second wait and replied after 7,287 ms. Its child was still running then, remained running after browser reload, completed, and returned `3`. The public title was `Count files` before and after reconnect. [Structured result](real-model-success.json), [running child](real-model-success-before-reconnect.png), [completed result](real-model-success-terminal.png).

Failure injection pinned only the child in the isolated QA configuration to `qa-intentionally-unavailable-model`, with fallback disabled. The parent still used the authenticated real model. Hermes reported the child failed, and Paseo retained failed state after reconnect. This is a genuine runtime failure induced through normal child model routing; it is not a scripted status event, an organic failure, or evidence of successful inference by the unavailable child model. Raw upstream errors and HTTP status were not retained, so no specific HTTP response is claimed. The public child timeline is empty because this channel does not forward raw failure summaries. [Structured result](real-model-failure.json), [failed child](real-model-failure-terminal.png).

An earlier attempt to induce failure with a two-second timeout did not fail: Hermes floors that setting at 30 seconds and renews the inactivity budget when work progresses. That child completed normally. It is excluded from the passing failure-injection claim. Two early UI attempts also stopped at a wrong test locator: the title is in the tab, outside the timeline panel. The corrected live tests passed. Model timing and tool choices are nondeterministic; the recorded observations do not guarantee identical future runs.

## Current no-model screenshots

The companion Python fixture exercises the actual Hermes relay, callback wiring, journal and serializer without inference. It verifies concurrent and nested identities using Hermes' native zero-based relay depth, cross-turn completed/failed/canceled events and reconnect retention. It makes no model requests.

- [Light running list](desktop-light-running.png), [nested panel](desktop-light-nested.png), [reconnected](desktop-light-reconnected.png).
- [Dark running list](desktop-dark-running.png), [nested panel](desktop-dark-nested.png), [reconnected](desktop-dark-reconnected.png).
- [Compact running list](compact-light-running.png), [nested panel](compact-light-nested.png), [reconnected](compact-light-reconnected.png).
- [16,384-character incomplete-output notice](limits-output-incomplete.png), [32-activity incomplete-record notice](limits-incomplete-record.png), [64-child omission notice in the parent](limits-omitted-children.png).

The three existing `.webm` recordings are from the first pass, before safe task titles and visible limit flags. They remain historical no-model evidence, not recordings of the current title/limit behavior.

## Reproduce

After normal workspace setup, run from `packages/app`:

```sh
npx playwright test e2e/browser/hermes-subagents.spec.ts --project browser --workers 1
```

For both checkouts without a model, set `PASEO_HERMES_ACP_FIXTURE_PYTHON` to an interpreter with the Hermes ACP extra and `PASEO_HERMES_ACP_FIXTURE_SCRIPT` to the companion checkout's `tests/acp_adapter/fixtures/subagent_agent.py`, then run that command.

For opt-in live-model QA, set `PASEO_HERMES_REAL_PYTHON` to the interpreter, `PASEO_HERMES_REAL_SCRIPT` to the companion `tests/acp_adapter/qa/real_model_agent.py`, and `PASEO_HERMES_REAL_AUTH_HOME` to an already authenticated Codex profile. The script uses `read_only=True`; it will not refresh expired credentials. Authenticate through the normal provider mechanism beforehand if needed.

```sh
npx playwright test e2e/browser/hermes-subagents.real.spec.ts --project real-provider --workers 1
PASEO_HERMES_REAL_FAIL_CHILD=1 npx playwright test e2e/browser/hermes-subagents.real.spec.ts --project real-provider --workers 1
```

Live tests make network requests and may consume quota. They are separate from deterministic CI fixtures. Local browser execution used installed Chrome with a temporary config; that machine-specific config is not committed.

## Review fixes and remaining scope

The second pass addresses all four existing Greptile comments: resume-only child replay, bounded/deadline-limited opening history, true replacement of cumulative text, and intent-level browser tests with typed field assertions. Hermes first-level relay depth is also corrected from native zero to wire depth one; the earlier fixture's one-based native depth hid this real-runtime bug.

Titles deliberately project goals to fixed public action/subject words rather than copying instructions. A task category can still be confidential; automatic projection or redaction cannot guarantee confidentiality. Limit flags are additive v1 fields, and ordinary ACP titles still explain limited records to older clients. Omitted-child state is a sticky boolean rather than an unbounded collection or an exact count.

Browser reconnect while a real child runs is verified. ACP load/resume-only replay, old journal compatibility and cold restore are covered by focused tests. An ACP process restart cannot preserve the old process's running worker: cold restore reports it failed. Native iOS, Android, Electron, Linux and Windows were not executed. No child stop/steer control or full raw transcript viewer is added. See the [shared contract](../../hermes-acp-subagents.md).
