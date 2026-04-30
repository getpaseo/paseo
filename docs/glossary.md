# Paseo Glossary

Authoritative terminology. UI label wins. Don't invent synonyms; use what's here.

- **Project** — Logical grouping of workspaces sharing a git remote (or main repo root). UI: "Project" / "Add a project". Code: `ProjectSummary` (`packages/app/src/utils/projects.ts:17`), `projectKey` (`packages/server/src/server/workspace-registry-model.ts:88`). Forbidden: "Repo", "Repository" as UI label.
- **Workspace** — One concrete `cwd` on one daemon, with git state; belongs to exactly one project. UI: "Workspace". Code: `WorkspaceDescriptorPayload` (`packages/server/src/shared/messages.ts:2128`). Don't confuse with: Branch (one branch can back many workspaces via worktrees). Forbidden: "Folder", "Directory" as UI label.
- **Workspace kind** — `"directory" | "local_checkout" | "worktree"`. Code: `PersistedWorkspaceKind` (`packages/server/src/server/workspace-registry-model.ts:9`).
- **Agent** — One AI coding agent run on a daemon (one provider, one model, one cwd, one timeline). UI: "Agent" / "New Agent". Code: `AgentSnapshotPayload` (`packages/server/src/shared/messages.ts:597`). Forbidden: "Task", "Job", "Run".
- **Daemon** — Local Paseo server process; identified by `serverId`. UI: "Daemon" (system contexts only). Code: `serverId` (`packages/server/src/shared/messages.ts:1886`), `DaemonClient` (`packages/server/src/client/daemon-client.ts`).
- **Host** — Client-side connection profile pointing at a daemon; bundles one or more `HostConnection`s. UI: "Host" / "Add host" / "Switch host". Code: `HostProfile` (`packages/app/src/types/host-connection.ts:36`). Forbidden: "Connection" (means `HostConnection`, not host).
- **Placement** — One workspace's relationship to its project (projectKey, projectName, git checkout snapshot). Internal. Code: `ProjectPlacementPayload` (`packages/server/src/shared/messages.ts:2063`).
- **Branch** — Plain git branch. UI: "Switch branch". Code: `currentBranch` (`packages/server/src/shared/messages.ts:2027`); `BranchSwitcher` (`packages/app/src/components/branch-switcher.tsx`).
- **Worktree** — Paseo-managed git worktree (`~/.paseo/worktrees/{name}`); also a `workspaceKind` value. UI: CLI + `paseo.json` keys (`worktree.setup`, `worktree.teardown`) only. Code: `ProjectCheckoutLiteGitPaseoPayload` (`packages/server/src/shared/messages.ts:2042`); CLI `paseo worktree` (`packages/cli/src/commands/worktree/index.ts:8`). Forbidden: "Checkout" as a synonym.
- **Repository / Remote** — Internal git inputs (`remoteUrl`, `mainRepoRoot`) used to derive `projectKey`. No UI label.
- **Session** — Per-client connection to a daemon. Internal. Code: `Session` (`packages/server/src/server/session.ts`). Don't confuse with: provider-side agent session log.
- **Profile** — Internal name for the persisted shape of a host. Code: `HostProfile` (`packages/app/src/types/host-connection.ts:36`). Never user-facing.
- **Provider** — Agent backend (Claude Code, Codex, OpenCode). UI: "Provider". Code: `ProviderSnapshotEntry` (`packages/server/src/shared/messages.ts:193`).
- **Model** — A specific LLM offered by a provider. UI: "Model" / "Select model". Code: `AgentModelDefinition` (`packages/server/src/shared/messages.ts:182`).
- **Terminal** — Workspace-scoped PTY shell streamed over the binary mux channel. UI: "Terminal". Code: `TerminalStreamFrame` (`packages/server/src/shared/terminal-stream-protocol.ts`).
- **Schedule** — Cron-style trigger that creates remote agents. UI: CLI only (`paseo schedule`). Code: `ScheduleCreateRequest` (re-exported from `packages/server/src/shared/messages.ts`). Don't confuse with: Loop (iterative re-execution of one agent).
- **Mode** — Provider-specific operational mode (plan, default, full-access, …). UI: icon-only. Code: `modeId` in `AgentSessionConfig` (`packages/server/src/shared/messages.ts:249`).
- **Attachment** — GitHub PR or Issue bound to an agent prompt. UI: "Attach issue or PR". Code: `AgentAttachment` (`packages/server/src/shared/messages.ts:736`).
- **Conflict** — Two distinct senses; do NOT use the bare word in UI copy without qualifying which: (a) **stale-write conflict** on `paseo.json` ("Config changed on disk", code `stale_project_config`, `packages/app/src/screens/project-settings-screen.tsx:576`); (b) **git merge conflict** (no current UI string).

## Open question — per-host project entry (TBD)

A project aggregates workspaces across daemons. The projects screen and project-settings screen need a name for "one row in the project list per (project, daemon)". `ProjectPlacementPayload` is **per-workspace**, so it isn't this thing — but the noun "placement" could naturally extend (`ProjectDaemonPlacement`, or just "placements grouped by daemon"). The in-progress `ProjectCheckout` type (`packages/app/src/utils/projects.ts:4`) is also per-workspace today, even though the settings UI selector treats it per-daemon (matched on `serverId` alone) — so the code is currently inconsistent with itself.

Candidates: (1) extend "placement" to the (project, daemon) bundle, (2) drop the wrapper type and use `{ host, project, workspaces[] }` plus descriptive UI copy ("project · host X · 2 online"). Recommendation: option (2) — no new noun, use existing terms compositionally. Do not introduce "Checkout" / `ProjectCheckout` as the canonical name.

## Rename before landing (in-progress `Checkout*` references)

- `packages/app/src/utils/projects.ts:4,20,22,23,46,85,104,120,124,126,146,148,155` — `ProjectCheckout`, `checkouts`, `checkoutCount`, `onlineCheckoutCount`, `buildCheckoutTarget`, `compareCheckouts`.
- `packages/app/src/screens/projects-screen.tsx:73,74,77,90` — `checkoutLabel`, `${checkoutCount} checkout(s)`, `onlineSuffix`.
- `packages/app/src/screens/project-settings-screen.tsx:17,41,46,55,76,81,110-152,323,443-600` — `ProjectCheckout` import, `CheckoutSelection`, `CheckoutSelector`, `CheckoutOption`, `usableCheckouts`, `onlineUsableCheckouts`, `selectedCheckout`, `selectedCheckoutKey`, "no online checkout", "no checkout with a valid server", `testID="checkout-selector"`, `testID="checkout-option-*"`, a11y `"Edit X checkout"`.
- `packages/app/src/screens/project-settings-screen.test.tsx:185,195,196,366,369,378,389,412,415,431,432,456,464,478,481,490,501,504,521` — `checkouts`, `checkoutCount`, `onlineCheckoutCount`, "no checkouts are online", "checkout selector", "online checkout".
- `packages/app/src/utils/projects.test.ts:107,108,111,259` — `checkoutCount`, `onlineCheckoutCount`, `checkouts`.

(Out of scope for this rename: `ProjectCheckoutLite*Payload` and the git-`checkout` family in `packages/server/src/utils/checkout-*.ts`. Those refer to _git_ checkout state, not the rejected (project, daemon) sense.)

## Inconsistencies (documented, not papered over)

- CLI `--host <host>` description `"Daemon host target"` (`packages/cli/src/commands/utils/command-options.ts:5`) blurs daemon/host; the app keeps them distinct.
- `WorkspaceDescriptorPayloadSchema.workspaceKind` accepts legacy `"checkout"` on the wire (`packages/server/src/shared/messages.ts:2137`) while `PersistedWorkspaceKind` does not (`packages/server/src/server/workspace-registry-model.ts:9`).
- In-progress `ProjectCheckout` (`packages/app/src/utils/projects.ts:4`) is per-workspace, but `project-settings-screen.tsx` selects by `serverId` alone — same daemon with multiple workspaces will produce duplicate React keys in the selector.
