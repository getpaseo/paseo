# Google Jules Provider — Design

**Status:** Design approved, awaiting implementation plan
**Date:** 2026-04-29

## Problem

Add Google Jules as a Paseo agent provider. Jules is a cloud-hosted, async, GitHub-repo-scoped coding agent — fundamentally different from Paseo's existing local-streaming providers (Claude, Codex, OpenCode, Cursor, Pi).

## Architectural framing

**Existing Paseo agents:** local processes, real-time streaming, operate on local cwd.
**Jules:** remote cloud sessions, async polling, operates on GitHub repos.

Jules is the first "remote async" provider. The integration introduces this as a new agent class rather than squeezing it into the local-streaming abstraction.

## Approach

Treat Jules as a remote async provider, transported via the `jules` CLI as a subprocess. MVP is read-mostly: create session from cwd's git remote, poll activities, render a final PR card.

### Architecture

```
mobile UI ── WS ── daemon ── JulesAgentClient ──► spawns `jules remote new/list/pull` (subprocess)
                                  │
                                  └── adaptive poller (5s → 30s idle, 2s post-activity)
                                       └── translates Jules activities → AgentStreamEvent
```

### Files to add / touch

| Path | Purpose |
|---|---|
| `packages/server/src/server/agent/providers/jules-agent.ts` | New — implements `AgentClient` |
| `packages/server/src/server/agent/providers/jules-cli.ts` | New — thin CLI wrapper (spawn, JSON parse) |
| `packages/server/src/server/agent/provider-manifest.ts` | Register `jules` provider id + definition |
| `packages/server/src/server/agent/provider-registry.ts` | Wire `jules` into `PROVIDER_CLIENT_FACTORIES` |
| `packages/app/src/components/timeline/*` | New `pr-ready` event card |

## Decisions

| Concern | Decision |
|---|---|
| Transport | `jules remote new --repo <owner/repo>` to create; `jules remote pull <session-id>` for updates. Prefer `--json` flag if available, else parse output. |
| Auth | Delegate to `jules login`. Provider's `isAvailable()` shells a non-interactive auth check; reports diagnostic. No OAuth code in Paseo. |
| Repo resolution | Read `origin` from cwd via existing `WorkspaceGitService`. Parse `github.com:owner/repo` (SSH) or `github.com/owner/repo` (HTTPS). Fail loudly with "not a GitHub repo" if absent. |
| Polling | Adaptive: 5s default, back off to 30s after 3 idle polls, fast-poll 2s for 30s after any new activity. |
| Streaming | New activities → emit as `AgentStreamEvent` with `provider: "jules"`. Map activity types to existing event kinds (assistant message, tool call, status). |
| Final output | When session = `COMPLETED` with PR URL → emit new event kind `pr-ready` (PR URL, branch, summary). Mobile renders tappable card. |
| Interrupt | Stops local poller only. Cloud session keeps running. `resumeSession` rehydrates by polling session ID. Documented as "detach, not cancel". |
| Modes | None for MVP. `defaultModeId: null`, `modes: []` (matches `pi` provider). |
| Capabilities | `supportsStreaming: false`, `supportsSessionPersistence: true`, `supportsDynamicModes: false`, `supportsMcpServers: false`, `supportsToolInvocations: true` (rendering, not executing). |
| Persistence | Session ID + repo + cwd in Paseo agent JSON; truth lives in Jules cloud. |

## Schema backward-compatibility

- New event kind `pr-ready` — must be additive, optional. **Verify** the current event parser default-cases unknown kinds (blocker if not).
- New provider id `jules` — `AgentProviderSchema` is `z.string()`, already permissive.
- No new required fields anywhere.
- Test: 6-month-old mobile client must parse a new daemon's Jules events without crashing.

## Risks

1. **CLI output stability.** Jules CLI is in flux. If `--json` is missing, table parsing breaks on Google updates. Mitigation: pin tested version range, fail loudly via diagnostic.
2. **Polling overhead at scale.** N concurrent Jules sessions → N pollers. Coalesce into one process-wide poller batching `remote list`.
3. **"Feels broken" UX.** Multi-minute silence reads as a hang next to Claude. Mitigation: surface intermediate activities aggressively; show "Jules is working remotely (~N min typical)" status badge.
4. **Auth diagnostic.** Need a non-interactive "am I logged in?" CLI command. If absent, attempt cheap `remote list` and parse auth-error string.
5. **Old client compat.** Verify mobile-side switch statements default-case unknown providers/event kinds.

## Out of scope (MVP)

- `sendMessage` mid-session (interactive Jules conversation)
- `approvePlan` (Jules' plan-approval primitive)
- Parallel session fleet UI
- Voice mode
- Inline PR diff rendering
- Auth UI in Paseo (delegated to user's terminal)

## Success criteria

- `paseo run --provider jules "fix failing tests"` from a GitHub-cloned cwd creates a Jules session; activities stream into mobile timeline.
- Close mobile app, reopen 30 min later, re-attach via `resumeSession` → final state including PR card.
- `npm run typecheck` + `npm run lint` clean.
- No regressions in Claude/Codex/OpenCode/Cursor/Pi providers.

## Open questions to resolve before/during planning

- Does `jules remote pull --json` exist? If not, what's the parsing strategy?
- What's the non-interactive auth check command? (`jules auth status`? Something else?)
- Do Jules activities have stable IDs we can use for de-dup across polls?
- Phase-2 trigger: when do we add `sendMessage` / plan approval? Suggest after 2 weeks of MVP usage data.
