---
title: Google Jules provider (MVP)
status: pending
created: 2026-04-29
design: docs/jules-provider-design.md
mode: fast
blockedBy: []
blocks: []
---

# Google Jules provider — Implementation plan

MVP scope: create + view Jules sessions from Paseo. No `sendMessage`, no `approvePlan`, no parallel fleet UI. Transport is the `jules` CLI as a subprocess. Repo is inferred from cwd's git origin. Polling is adaptive. Interrupt = detach (cloud session keeps running).

Design source of truth: `docs/jules-provider-design.md`. Read it before starting.

## Refinement on design

The design doc proposes a new top-level `AgentStreamEvent` kind `pr-ready`. **Use a new `AgentTimelineItem` variant `pr_ready` instead** — this is more backward-compatible (timeline items are already rendered through a switch with fallback) and matches existing patterns at `packages/server/src/server/agent/agent-sdk-types.ts:304-311`.

```ts
// agent-sdk-types.ts — add to AgentTimelineItem union
| { type: "pr_ready"; url: string; branch: string; title?: string; summary?: string }
```

Verify (Phase 0) that `packages/app` timeline rendering default-cases unknown `AgentTimelineItem.type` without crashing.

## Phase 0 — Verification gates (DO FIRST, can block)

Each must pass before moving to Phase 1. If any fails, stop and surface to user.

1. **Mobile timeline default-case.** Grep `packages/app/src` for the timeline item switch (likely a `switch (item.type)` in a renderer). Confirm default branch returns `null` / fallback view, not a throw.
2. **Jules CLI installed locally for dev.** `jules --version` should work. If not, install per https://jules.google/docs/cli/. If unavailable on Linux, document a mock-mode fallback.
3. **`jules remote pull --json` flag.** Run `jules remote pull --help` and `jules remote new --help`. If `--json` exists, use it. If not, fall back to parsing the table output AND surface a warning in the diagnostic.
4. **Non-interactive auth check.** Try `jules auth status`, `jules whoami`, or similar. If none exist, use `jules remote list` and parse the auth-required error.
5. **Activity stable IDs.** Sample output from `jules remote pull <session>` to confirm activities have unique IDs for de-dup across polls.

Output: short markdown note in this plan dir at `phase-0-findings.md` with verified flags + chosen fallbacks.

## Phase 1 — Daemon: CLI wrapper (`jules-cli.ts`)

File: `packages/server/src/server/agent/providers/jules-cli.ts`

Thin wrapper around the `jules` binary. No agent semantics — pure transport.

```ts
export interface JulesCliOptions {
  binaryPath?: string;          // default "jules"
  env?: NodeJS.ProcessEnv;
  logger: Logger;
}

export interface JulesActivity {
  id: string;
  type: string;                  // jules-native activity type
  createdAt: string;
  payload: unknown;              // raw JSON; agent layer maps to timeline items
}

export interface JulesSessionSnapshot {
  id: string;
  status: "QUEUED" | "RUNNING" | "AWAITING_INPUT" | "COMPLETED" | "FAILED" | string;
  repo: string;                  // owner/name
  branch?: string;
  prUrl?: string;
  prTitle?: string;
  activities: JulesActivity[];
}

export class JulesCli {
  constructor(opts: JulesCliOptions);

  authStatus(): Promise<{ loggedIn: boolean; account?: string; diagnostic?: string }>;
  version(): Promise<string>;

  remoteNew(args: { repo: string; prompt: string }): Promise<{ sessionId: string }>;
  remoteList(): Promise<JulesSessionSnapshot[]>;
  remotePull(sessionId: string): Promise<JulesSessionSnapshot>;
}
```

- Use `spawnProcess` from `@server/utils/spawn` (consistent with `cursor-cli-agent.ts:38`).
- Use `findExecutable` (consistent with cursor pattern).
- Prefer `--json`; if absent, throw a typed `JulesCliFormatError` from a small parser.
- Tests: `jules-cli.test.ts` with `execFile` mocked. Cover JSON branch, fallback parse branch, auth-required error.

## Phase 2 — Repo inference helper

File: `packages/server/src/server/agent/providers/jules-repo.ts` (new)

```ts
export async function resolveGitHubRepo(
  cwd: string,
  workspaceGitService: WorkspaceGitService,
): Promise<{ owner: string; name: string }>;
```

- Use `workspaceGitService.resolveRepoRoot(cwd)` (already in registry).
- Read `origin` URL via `git remote get-url origin` (or use existing helper if any exists; grep `workspace-git-service.ts` first).
- Parse both SSH (`git@github.com:owner/name.git`) and HTTPS (`https://github.com/owner/name(.git)?`).
- Throw `JulesRepoError` with diagnostic message when not GitHub or no remote.
- Tests: `jules-repo.test.ts` covering both URL forms + missing-remote + non-github cases.

## Phase 3 — Daemon: Agent client (`jules-agent.ts`)

File: `packages/server/src/server/agent/providers/jules-agent.ts`

Implements `AgentClient` and `AgentSession`. Use `pi-direct-agent.ts` and `cursor-cli-agent.ts` as structural references (whichever is simpler — likely cursor since pi has more LLM machinery).

### Capabilities
```ts
const JULES_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,   // we render tool-call timeline items, but don't execute locally
};
```

### Client surface (mostly delegating to a session)
- `createSession(config)`:
  1. Resolve repo from cwd.
  2. Call `cli.remoteNew({ repo, prompt })`.
  3. Construct `JulesAgentSession` with returned `sessionId`.
  4. Emit `thread_started` + start poller.
- `resumeSession(handle)`: rehydrate from `handle.providerData.sessionId`, fetch latest snapshot, replay activities → timeline.
- `listModels()`: return `[]` (no models).
- `listModes()`: `[]`.
- `isAvailable()`: `cli.version()` + `cli.authStatus()`. Fail with helpful diagnostic if not logged in.
- `getDiagnostic()`: format CLI version, auth status, last error.

### Session — adaptive poller
```
state = { intervalMs: 5000, idlePolls: 0, lastActivityAt: 0 }
on tick:
  snapshot = await cli.remotePull(sessionId)
  newActivities = diff(snapshot.activities, lastSeenIds)
  for a in newActivities:
    emit timeline event mapping a → AgentTimelineItem
  if newActivities.length > 0:
    lastActivityAt = now()
    state.intervalMs = 2000     // fast-poll window
    state.idlePolls = 0
  else:
    state.idlePolls++
    if (now() - lastActivityAt) > 30_000:
      state.intervalMs = 5000   // back to default
    if state.idlePolls >= 3:
      state.intervalMs = 30_000 // idle backoff

  if snapshot.status in ["COMPLETED","FAILED"]:
    if status === "COMPLETED" && snapshot.prUrl:
      emit timeline { type: "pr_ready", url, branch, title }
    emit turn_completed (or turn_failed)
    stop poller
```

### Activity → timeline mapping
Implement a small mapper. For MVP, sensible defaults:
- text/message activity → `{ type: "assistant_message", text }`
- thinking/reasoning activity → `{ type: "reasoning", text }`
- tool/file-edit activity → `ToolCallTimelineItem` (use `tool-call-detail-primitives.ts` helpers)
- unknown activity → `{ type: "assistant_message", text: JSON.stringify(payload) }` (graceful fallback, not error)

### Lifecycle
- `interrupt()`: stop poller. Do NOT call any cancel API. Emit `turn_canceled` with `reason: "detached"`.
- `close()`: stop poller. No API call.
- `describePersistence()`: returns `{ provider: "jules", providerData: { sessionId, repo } }`.

### Tests
`jules-agent.test.ts`:
- Creating session calls `remoteNew` with parsed repo, returns wrapped session.
- Polling emits timeline events for new activities, dedupes by ID.
- Adaptive cadence: after activity, next interval is 2s; after 3 idle polls, interval is 30s.
- COMPLETED + prUrl → `pr_ready` timeline + `turn_completed`.
- FAILED → `turn_failed` with diagnostic.
- `interrupt()` stops poller without API call.
- `resumeSession` replays activities.

## Phase 4 — Wire registry + manifest

File: `packages/server/src/server/agent/provider-manifest.ts`

Add to `AGENT_PROVIDER_DEFINITIONS`:
```ts
{
  id: "jules",
  label: "Jules",
  description: "Google's async cloud coding agent. Operates on GitHub repos; sessions run remotely and produce PRs. Requires `jules login`.",
  defaultModeId: null,
  modes: [],
}
```

File: `packages/server/src/server/agent/provider-registry.ts`

Import + register:
```ts
import { JulesAgentClient } from "./providers/jules-agent.js";
// ...
const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  // ...existing...
  jules: (logger, runtimeSettings, options) =>
    new JulesAgentClient({
      logger,
      runtimeSettings,
      workspaceGitService: options?.workspaceGitService,
    }),
};
```

Tests: `provider-registry.test.ts` snapshot updates; `provider-availability.test.ts` if it iterates definitions.

## Phase 5 — Schema extension (timeline item)

File: `packages/server/src/server/agent/agent-sdk-types.ts`

Add to `AgentTimelineItem` union (line 304):
```ts
| { type: "pr_ready"; url: string; branch: string; title?: string; summary?: string }
```

Then trace usages:
- Find Zod schema mirror (likely in `packages/server/src/shared/messages.ts` or similar). Add the variant. **All new fields must be `.optional()` except `type`, `url`, `branch`** to preserve forward compat for old daemons that don't emit the title/summary.
- Update any exhaustive switches the typechecker now flags — add a fallback case (don't throw on unknown variants, even with the new type known; this protects against future variants).

## Phase 6 — Mobile: PR-ready timeline card

File: `packages/app/src/components/timeline/...` (locate exact file via grep for an existing item type like `assistant_message`)

- Add a renderer for `pr_ready`: a tappable card showing PR title (or branch), `Pressable` opens `url` via `Linking.openURL` (cross-platform).
- Add a small "Jules is working remotely" status badge near the input bar when an agent's provider is `jules` and last activity was >30s ago (UX gap mitigation from design doc risk #3).
- Verify: existing default case in the timeline switch does NOT need touching if Phase 0 confirmed it has a fallback.

Tests: snapshot/component test for the new card.

## Phase 7 — Backward-compat verification

Manually verify each:
1. Old mobile client + new daemon: spin up old client (use a tag from 6+ months back), connect to new daemon with a Jules agent. Confirm no crash. Old client should silently skip `pr_ready` items.
2. New mobile client + old daemon: confirm `jules` provider just doesn't appear in the picker (registry is daemon-side).
3. CLI: `paseo run --provider jules "test prompt"` from a GitHub-cloned cwd works end-to-end.

## Phase 8 — Docs

- Update `docs/PROVIDERS.md` with a Jules section. Be honest about: cloud/async, GitHub-only, requires `jules login`, no MCP, no live streaming, "interrupt = detach" semantics.
- Update `CLAUDE.md` "Supported agents" list.
- Add a note to `docs/CUSTOM-PROVIDERS.md` if relevant (likely not — Jules isn't extends-style).

## Critical rules (from CLAUDE.md, copied for the implementer)

- Run `npm run typecheck` and `npm run lint` after every significant change.
- Run `npm run format` before committing.
- Run only the specific test file: `npx vitest run <file> --bail=1`. Never run the full suite.
- All new schema fields `.optional()` (except discriminator + truly required ones).
- Never narrow an existing field type.
- No mocks for git/CLI in integration tests where real commands are cheap.

## Out of scope (re-state to prevent scope creep)

- `sendMessage` mid-session
- `approvePlan` plan-approval flow
- Parallel session fleet view
- Voice mode
- Inline PR diff rendering
- Custom OAuth flow in Paseo (delegated to `jules login`)

## Open questions

- Exact Jules activity payload schema (resolved by Phase 0 sampling).
- Whether `jules` CLI exposes `--json` (resolved by Phase 0).
- Phase-2 ramp: when to add `sendMessage` / plan approval. Suggest: after 2 weeks of MVP usage telemetry.

## Done checklist

- [ ] Phase 0 findings written
- [ ] CLI wrapper + tests
- [ ] Repo helper + tests
- [ ] Agent client + tests
- [ ] Registry + manifest wired
- [ ] Schema extension (timeline + zod mirror)
- [ ] Mobile renderer
- [ ] Backward-compat verified (old client + new daemon)
- [ ] Typecheck, lint, format clean
- [ ] PROVIDERS.md updated
