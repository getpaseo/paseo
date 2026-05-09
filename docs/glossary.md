# Paseo Glossary

Authoritative terminology. UI label wins. Don't invent synonyms; use what's here.

- **Project** — Logical grouping of workspaces sharing a git remote (or main repo root). UI: "Project" / "Add project". Code: `ProjectSummary` (`packages/app/src/utils/projects.ts:22`), `projectKey` (`packages/server/src/server/workspace-registry-model.ts:16`). Forbidden: "Repo", "Repository" as UI label.
- **Workspace** — One concrete `cwd` on one daemon, with git state; belongs to exactly one project. UI: "Workspace". Code: `WorkspaceDescriptorPayload` (`packages/server/src/shared/messages.ts:2178`). Don't confuse with: Branch (one branch can back many workspaces via worktrees). Forbidden: "Folder", "Directory" as UI label.
- **Workspace kind** — `"directory" | "local_checkout" | "worktree"`. Code: `PersistedWorkspaceKind` (`packages/server/src/server/workspace-registry-model.ts:8`).
- **Agent** — One AI coding agent run on a daemon (one provider, one model, one cwd, one timeline). UI: "Agent" / "New Agent". Code: `AgentSnapshotPayload` (`packages/server/src/shared/messages.ts:608`). Forbidden: "Task", "Job", "Run".
- **Daemon** — Local Paseo server process; identified by `serverId`. UI: "Daemon" (system contexts only). Code: `serverId` in `ServerInfoStatusPayloadSchema` (`packages/server/src/shared/messages.ts:1936`), `DaemonClient` (`packages/server/src/client/daemon-client.ts`).
- **Host** — Client-side connection profile pointing at a daemon; bundles one or more `HostConnection`s. UI: "Host" / "Add host" / "Switch host". Code: `HostProfile` (`packages/app/src/types/host-connection.ts:37`). Forbidden: "Connection" (means `HostConnection`, not host).
- **Project host entry** — One row in a project for a single (project, daemon) pair, aggregating that daemon's workspaces in the project. Internal. Code: `ProjectHostEntry` (`packages/app/src/utils/projects.ts:11`). Don't introduce "Checkout" as a synonym.
- **Placement** — One workspace's relationship to its project (projectKey, projectName, git checkout snapshot). Internal. Code: `ProjectPlacementPayload` (`packages/server/src/shared/messages.ts:2113`).
- **Branch** — Plain git branch. UI: "Switch branch". Code: `currentBranch` in `WorkspaceGitRuntimePayloadSchema` (`packages/server/src/shared/messages.ts:2136`); `BranchSwitcher` (`packages/app/src/components/branch-switcher.tsx`).
- **Worktree** — Paseo-managed git worktree (`~/.paseo/worktrees/{name}`); also a `workspaceKind` value. UI: CLI + `paseo.json` keys (`worktree.setup`, `worktree.teardown`) only. Code: `ProjectCheckoutLiteGitPaseoPayload` (`packages/server/src/shared/messages.ts:2092`); CLI `paseo worktree` (`packages/cli/src/commands/worktree/index.ts:8`). Forbidden: "Checkout" as a synonym.
- **Repository / Remote** — Internal git inputs (`remoteUrl`, `mainRepoRoot`) used to derive `projectKey`. No UI label.
- **Session** — Per-client connection to a daemon. Internal. Code: `Session` (`packages/server/src/server/session.ts`). Don't confuse with: provider-side agent session log.
- **Profile** — Internal name for the persisted shape of a host. Code: `HostProfile` (`packages/app/src/types/host-connection.ts:37`). Never user-facing.
- **Provider** — Agent backend (Claude Code, Codex, OpenCode). UI: "Provider". Code: `ProviderSnapshotEntry` (`packages/server/src/shared/messages.ts:198`).
- **Model** — A specific LLM offered by a provider. UI: "Model" / "Select model". Code: `AgentModelDefinition` (`packages/server/src/shared/messages.ts:187`).
- **Terminal** — Workspace-scoped PTY shell streamed over the binary mux channel. UI: "Terminal". Code: `TerminalStreamFrame` (`packages/server/src/shared/terminal-stream-protocol.ts`).
- **Schedule** — Cron-style trigger that creates remote agents. UI: CLI only (`paseo schedule`). Code: `ScheduleCreateRequest` (re-exported from `packages/server/src/shared/messages.ts`). Don't confuse with: Loop (iterative re-execution of one agent).
- **Mode** — Provider-specific operational mode (plan, default, full-access, …). UI: icon-only. Code: `modeId` in `AgentSessionConfig` (`packages/server/src/shared/messages.ts:257`).
- **Attachment** — GitHub PR or Issue bound to an agent prompt. UI: "Attach issue or PR". Code: `AgentAttachment` (`packages/server/src/shared/messages.ts:782`).
- **Conflict** — Two distinct senses; do NOT use the bare word in UI copy without qualifying which: (a) **stale-write conflict** on `paseo.json` ("Config changed on disk", code `stale_project_config`, `packages/app/src/screens/project-settings-screen.tsx:593`); (b) **git merge conflict** (no current UI string).

## Inconsistencies (documented, not papered over)

- CLI `--host <host>` description `"Daemon host target"` (`packages/cli/src/utils/command-options.ts:5`) blurs daemon/host; the app keeps them distinct.
- `WorkspaceDescriptorPayloadSchema.workspaceKind` accepts legacy `"checkout"` on the wire (`packages/server/src/shared/messages.ts:2187`) while `PersistedWorkspaceKind` does not (`packages/server/src/server/workspace-registry-model.ts:8`).
