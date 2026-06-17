# Data Model

Paseo uses **file-based JSON persistence** instead of a traditional database. All data is validated at runtime with Zod schemas. Most stores write atomically (write to temp file, then rename); a few still use plain `writeFile` — see each section. There is no schema-versioning/migration framework — schemas rely on optional fields with defaults for forward compatibility, with a small amount of inline normalization in `persisted-config.ts` for legacy provider/speech entries.

All server-side stores live under `$PASEO_HOME` (defaults to `~/.paseo`).

---

## Directory layout

```
$PASEO_HOME/
├── config.json                          # Daemon configuration
├── server-id                            # Stable daemon identifier (plain text, "srv_<base64url>")
├── daemon-keypair.json                  # E2EE keypair for relay (mode 0600)
├── paseo.pid                            # Daemon PID lock file
├── daemon.log                           # Default log file (path configurable)
├── agents/
│   └── {sanitized-cwd}/
│       └── {agentId}.json               # One file per agent
├── schedules/
│   └── {scheduleId}.json                # One file per schedule
├── chat/
│   └── rooms.json                       # All rooms + messages
├── loops/
│   └── loops.json                       # All loop records
├── projects/
│   ├── projects.json                    # Project registry
│   └── workspaces.json                  # Workspace registry
└── push-tokens.json                     # Expo push notification tokens
```

The `agents/{sanitized-cwd}/` directory name is derived from the agent's `cwd` by stripping the filesystem root and replacing path separators with `-` (Windows drive letters become a `C-` style prefix). Persistent server stores write atomically by writing a temp file in the target directory and then renaming it into place.

---

## 1. Agent Record

**Path:** `$PASEO_HOME/agents/{project-dir}/{agentId}.json`

Each agent is stored as a separate JSON file, grouped by project directory.

| Field                | Type                                     | Description                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `string`                                 | UUID, primary key                                                                                                                                                                                                                                                                                                                                                                   |
| `provider`           | `string`                                 | Agent provider (`"claude"`, `"codex"`, `"opencode"`, etc.)                                                                                                                                                                                                                                                                                                                          |
| `cwd`                | `string`                                 | Working directory the agent operates in                                                                                                                                                                                                                                                                                                                                             |
| `workspaceId`        | `string?`                                | Owning workspace id — the single source of ownership. Every agent is stamped with one at create time; legacy cwd-only records are backfilled once by `migrations/backfill-workspace-id.migration.ts` (the only place a cwd→id mapping exists). Runtime code never infers ownership or status from cwd: status is computed per `workspaceId`, and same-cwd siblings are independent. |
| `createdAt`          | `string` (ISO 8601)                      | Creation timestamp                                                                                                                                                                                                                                                                                                                                                                  |
| `updatedAt`          | `string` (ISO 8601)                      | Last update timestamp                                                                                                                                                                                                                                                                                                                                                               |
| `lastActivityAt`     | `string?` (ISO 8601)                     | Last activity timestamp                                                                                                                                                                                                                                                                                                                                                             |
| `lastUserMessageAt`  | `string?` (ISO 8601)                     | Last user message timestamp                                                                                                                                                                                                                                                                                                                                                         |
| `title`              | `string?`                                | User-visible title                                                                                                                                                                                                                                                                                                                                                                  |
| `labels`             | `Record<string, string>`                 | Key-value labels (default `{}`). `paseo.parent-agent-id` set automatically when launched via the `create_agent` MCP tool — see [agent-lifecycle.md](./agent-lifecycle.md)                                                                                                                                                                                                           |
| `lastStatus`         | `AgentStatus`                            | One of: `"initializing"`, `"idle"`, `"running"`, `"error"`, `"closed"`                                                                                                                                                                                                                                                                                                              |
| `lastModeId`         | `string?`                                | Last active mode ID                                                                                                                                                                                                                                                                                                                                                                 |
| `config`             | `SerializableConfig?`                    | Agent session configuration (see below)                                                                                                                                                                                                                                                                                                                                             |
| `runtimeInfo`        | `RuntimeInfo?`                           | Live runtime state (see below)                                                                                                                                                                                                                                                                                                                                                      |
| `features`           | `AgentFeature[]?`                        | Provider-reported features (toggles/selects)                                                                                                                                                                                                                                                                                                                                        |
| `persistence`        | `PersistenceHandle?`                     | Handle for resuming sessions                                                                                                                                                                                                                                                                                                                                                        |
| `lastError`          | `string?` (nullable)                     | Last error message, if any                                                                                                                                                                                                                                                                                                                                                          |
| `requiresAttention`  | `boolean?`                               | Whether the agent needs user attention                                                                                                                                                                                                                                                                                                                                              |
| `attentionReason`    | `"finished" \| "error" \| "permission"?` | Why attention is needed                                                                                                                                                                                                                                                                                                                                                             |
| `attentionTimestamp` | `string?` (ISO 8601)                     | When attention was flagged                                                                                                                                                                                                                                                                                                                                                          |
| `internal`           | `boolean?`                               | Whether this is a system-internal agent (loop workers, etc.)                                                                                                                                                                                                                                                                                                                        |
| `archivedAt`         | `string?` (ISO 8601)                     | Soft-delete timestamp                                                                                                                                                                                                                                                                                                                                                               |

### Nested: SerializableConfig

| Field              | Type                       | Description                  |
| ------------------ | -------------------------- | ---------------------------- |
| `title`            | `string?`                  | Configured title             |
| `modeId`           | `string?`                  | Configured mode              |
| `model`            | `string?`                  | Configured model             |
| `thinkingOptionId` | `string?`                  | Thinking/reasoning level     |
| `featureValues`    | `Record<string, unknown>?` | Feature preference overrides |
| `extra`            | `Record<string, any>?`     | Provider-specific config     |
| `systemPrompt`     | `string?`                  | Custom system prompt         |
| `mcpServers`       | `Record<string, any>?`     | MCP server configurations    |

### Nested: RuntimeInfo

| Field              | Type                       | Description                    |
| ------------------ | -------------------------- | ------------------------------ |
| `provider`         | `string`                   | Active provider                |
| `sessionId`        | `string?`                  | Active session ID              |
| `model`            | `string?`                  | Active model                   |
| `thinkingOptionId` | `string?`                  | Active thinking option         |
| `modeId`           | `string?`                  | Active mode                    |
| `extra`            | `Record<string, unknown>?` | Provider-specific runtime data |

### Nested: PersistenceHandle

| Field          | Type                   | Description                                                           |
| -------------- | ---------------------- | --------------------------------------------------------------------- |
| `provider`     | `string`               | Provider that owns the session                                        |
| `sessionId`    | `string`               | Session ID for resumption                                             |
| `nativeHandle` | `any?`                 | Provider-specific handle (Codex thread ID, Claude resume token, etc.) |
| `metadata`     | `Record<string, any>?` | Extra metadata                                                        |

### Nested: AgentFeature (discriminated union on `type`)

**Toggle:**

| Field         | Type       |
| ------------- | ---------- |
| `type`        | `"toggle"` |
| `id`          | `string`   |
| `label`       | `string`   |
| `description` | `string?`  |
| `tooltip`     | `string?`  |
| `icon`        | `string?`  |
| `value`       | `boolean`  |

**Select:**

| Field         | Type                  |
| ------------- | --------------------- |
| `type`        | `"select"`            |
| `id`          | `string`              |
| `label`       | `string`              |
| `description` | `string?`             |
| `tooltip`     | `string?`             |
| `icon`        | `string?`             |
| `value`       | `string \| null`      |
| `options`     | `AgentSelectOption[]` |

---

## Runtime-only Terminal Sessions

Terminals are live daemon state, not persisted JSON records. A terminal carries a `workspaceId` while it is running; workspace-scoped terminal lists include only terminals with the matching `workspaceId`. Legacy live terminals without an owner remain visible to unscoped terminal reads but contribute to no workspace status.

Terminal activity contributes to the workspace status bucket **per `workspaceId`**: a working terminal drives `running` onto the workspace it carries only. Same-`cwd` siblings are untouched; terminal visibility is likewise `workspaceId`-scoped.

---

## 2. Daemon Configuration

**Path:** `$PASEO_HOME/config.json`

Single file, validated with `PersistedConfigSchema`.

```
{
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    hostnames: true | string[],   // legacy alias `allowedHosts` is migrated on load
    mcp: { enabled: boolean, injectIntoAgents: boolean },
    appendSystemPrompt: string,    // appended to supported provider system/developer prompts
    cors: { allowedOrigins: string[] },
    relay: { enabled: boolean, endpoint: string, publicEndpoint: string, useTls: boolean, publicUseTls: boolean },
    auth: { password: string }    // bcrypt hash, optional
  },
  app: {
    baseUrl: string
  },
  worktrees?: {
    root?: string            // optional root for new worktrees; defaults to $PASEO_HOME/worktrees
  },
  providers: {
    openai: { apiKey: string },
    local: { modelsDir: string }
  },
  agents: {
    // ProviderOverrideSchema; legacy entries with `command: { mode, ... }` are migrated to the
    // current shape on load via `migrateProviderSettings`. Custom provider IDs must declare
    // `extends` (one of the built-ins or `"acp"`) and `label`. See `provider-launch-config.ts`.
    providers: Record<providerId, ProviderOverride>,
    metadataGeneration: {
      providers: [{ provider, model?, thinkingOptionId? }]
    }
  },
  features: {
    dictation: { enabled, stt: { provider, model, language, confidenceThreshold } },
    voiceMode: { enabled, llm, stt: { provider, model, language }, turnDetection, tts: { provider, model, voice, speakerId, speed } }
  },
  log: {
    level, format,
    console: { level, format },
    file: { level, path, rotate: { maxSize, maxFiles } }
  }
}
```

All fields are optional with sensible defaults.

`agents.metadataGeneration.providers` controls the preferred structured-generation fallback order for daemon-side metadata tasks such as commit messages, PR text, branch names, and generated agent titles. Entries are tried first in the configured order, then Paseo falls through to dynamically discovered defaults and finally the current selection when available.

Local speech model ids are intentionally narrow: STT uses `parakeet-tdt-0.6b-v2-int8`, TTS uses `kokoro-en-v0_19`, and turn detection uses the bundled Silero VAD model.

---

## 3. Schedule

**Path:** `$PASEO_HOME/schedules/{id}.json`

One file per schedule. ID is 8 hex characters.

| Field       | Type                                  | Description                      |
| ----------- | ------------------------------------- | -------------------------------- |
| `id`        | `string`                              | 8-char hex ID                    |
| `name`      | `string?`                             | Human-readable name              |
| `prompt`    | `string`                              | The prompt to send               |
| `cadence`   | `ScheduleCadence`                     | Timing (see below)               |
| `target`    | `ScheduleTarget`                      | What to run (see below)          |
| `status`    | `"active" \| "paused" \| "completed"` | Current state                    |
| `createdAt` | `string` (ISO 8601)                   |                                  |
| `updatedAt` | `string` (ISO 8601)                   |                                  |
| `nextRunAt` | `string?` (ISO 8601)                  | Next scheduled execution         |
| `lastRunAt` | `string?` (ISO 8601)                  | Last execution time              |
| `pausedAt`  | `string?` (ISO 8601)                  | When paused                      |
| `expiresAt` | `string?` (ISO 8601)                  | Auto-expire time                 |
| `maxRuns`   | `number?`                             | Max executions before completing |
| `runs`      | `ScheduleRun[]`                       | Execution history                |

### Nested: ScheduleCadence (discriminated union on `type`)

- `{ type: "every", everyMs: number }` — interval in milliseconds
- `{ type: "cron", expression: string, timezone?: string }` — cron expression; absent `timezone` means UTC, present `timezone` is an IANA time zone used for local wall-clock recurrence

### Nested: ScheduleTarget (discriminated union on `type`)

- `{ type: "agent", agentId: string }` — send to existing agent
- `{ type: "new-agent", config: { provider, cwd, modeId?, model?, thinkingOptionId?, title?, approvalPolicy?, sandboxMode?, networkAccess?, webSearch?, extra?, systemPrompt?, mcpServers? } }` — create a new agent

### Nested: ScheduleRun

| Field          | Type                                   | Description             |
| -------------- | -------------------------------------- | ----------------------- |
| `id`           | `string`                               | Run ID                  |
| `scheduledFor` | `string` (ISO 8601)                    | Intended execution time |
| `startedAt`    | `string` (ISO 8601)                    |                         |
| `endedAt`      | `string?` (ISO 8601)                   |                         |
| `status`       | `"running" \| "succeeded" \| "failed"` |                         |
| `agentId`      | `string?` (UUID)                       | Agent used for this run |
| `output`       | `string?`                              | Agent output text       |
| `error`        | `string?`                              | Error message if failed |

---

## 4. Chat

**Path:** `$PASEO_HOME/chat/rooms.json`

Single file containing all rooms and messages.

```json
{
  "rooms": [ ... ],
  "messages": [ ... ]
}
```

### ChatRoom

| Field       | Type                | Description                         |
| ----------- | ------------------- | ----------------------------------- |
| `id`        | `string` (UUID)     |                                     |
| `name`      | `string`            | Unique room name (case-insensitive) |
| `purpose`   | `string?`           | Room description                    |
| `createdAt` | `string` (ISO 8601) |                                     |
| `updatedAt` | `string` (ISO 8601) | Updated on each new message         |

### ChatMessage

| Field              | Type                | Description                         |
| ------------------ | ------------------- | ----------------------------------- |
| `id`               | `string` (UUID)     |                                     |
| `roomId`           | `string`            | FK to ChatRoom.id                   |
| `authorAgentId`    | `string`            | Agent ID of the author              |
| `body`             | `string`            | Message text (supports `@mentions`) |
| `replyToMessageId` | `string?`           | FK to another ChatMessage.id        |
| `mentionAgentIds`  | `string[]`          | Extracted `@mention` agent IDs      |
| `createdAt`        | `string` (ISO 8601) |                                     |

---

## 5. Loop

**Path:** `$PASEO_HOME/loops/loops.json`

Single file containing an array of all loop records. Writes are direct (not atomic) and serialized through an in-memory queue. On daemon startup any record with `status: "running"` is recovered as `"stopped"` with an interruption log entry.

| Field                   | Type                                                | Description                                |
| ----------------------- | --------------------------------------------------- | ------------------------------------------ |
| `id`                    | `string`                                            | 8-char UUID prefix                         |
| `name`                  | `string?`                                           | Human-readable name                        |
| `prompt`                | `string`                                            | Worker prompt                              |
| `cwd`                   | `string`                                            | Working directory                          |
| `provider`              | `string`                                            | Default provider                           |
| `model`                 | `string?`                                           | Default model                              |
| `modeId`                | `string?`                                           | Default mode ID                            |
| `workerProvider`        | `string?`                                           | Override provider for workers              |
| `workerModel`           | `string?`                                           | Override model for workers                 |
| `verifierProvider`      | `string?`                                           | Override provider for verifiers            |
| `verifierModel`         | `string?`                                           | Override model for verifiers               |
| `verifierModeId`        | `string?`                                           | Override mode ID for verifiers             |
| `verifyPrompt`          | `string?`                                           | LLM verification prompt                    |
| `verifyChecks`          | `string[]`                                          | Shell commands to run as checks            |
| `archive`               | `boolean`                                           | Whether to archive worker agents after use |
| `sleepMs`               | `number`                                            | Delay between iterations (ms)              |
| `maxIterations`         | `number?`                                           | Cap on iterations                          |
| `maxTimeMs`             | `number?`                                           | Total time budget (ms)                     |
| `status`                | `"running" \| "succeeded" \| "failed" \| "stopped"` |                                            |
| `createdAt`             | `string` (ISO 8601)                                 |                                            |
| `updatedAt`             | `string` (ISO 8601)                                 |                                            |
| `startedAt`             | `string` (ISO 8601)                                 |                                            |
| `completedAt`           | `string?` (ISO 8601)                                |                                            |
| `stopRequestedAt`       | `string?` (ISO 8601)                                |                                            |
| `iterations`            | `LoopIteration[]`                                   |                                            |
| `logs`                  | `LoopLogEntry[]`                                    |                                            |
| `nextLogSeq`            | `number`                                            | Monotonic log sequence counter             |
| `activeIteration`       | `number?`                                           | Currently executing iteration index        |
| `activeWorkerAgentId`   | `string?`                                           | Currently running worker agent             |
| `activeVerifierAgentId` | `string?`                                           | Currently running verifier agent           |

### Nested: LoopIteration

| Field               | Type                                                | Description              |
| ------------------- | --------------------------------------------------- | ------------------------ |
| `index`             | `number`                                            | 1-based iteration index  |
| `workerAgentId`     | `string?`                                           | Agent ID of the worker   |
| `workerStartedAt`   | `string` (ISO 8601)                                 |                          |
| `workerCompletedAt` | `string?` (ISO 8601)                                |                          |
| `verifierAgentId`   | `string?`                                           | Agent ID of the verifier |
| `status`            | `"running" \| "succeeded" \| "failed" \| "stopped"` |                          |
| `workerOutcome`     | `"completed" \| "failed" \| "canceled"?`            |                          |
| `failureReason`     | `string?`                                           |                          |
| `verifyChecks`      | `LoopVerifyCheckResult[]`                           | Shell check results      |
| `verifyPrompt`      | `LoopVerifyPromptResult?`                           | LLM verification result  |

### Nested: LoopLogEntry

| Field       | Type                                                 |
| ----------- | ---------------------------------------------------- |
| `seq`       | `number` (monotonic)                                 |
| `timestamp` | `string` (ISO 8601)                                  |
| `iteration` | `number?`                                            |
| `source`    | `"loop" \| "worker" \| "verifier" \| "verify-check"` |
| `level`     | `"info" \| "error"`                                  |
| `text`      | `string`                                             |

### Nested: LoopVerifyCheckResult

| Field         | Type                |
| ------------- | ------------------- |
| `command`     | `string`            |
| `exitCode`    | `number`            |
| `passed`      | `boolean`           |
| `stdout`      | `string`            |
| `stderr`      | `string`            |
| `startedAt`   | `string` (ISO 8601) |
| `completedAt` | `string` (ISO 8601) |

### Nested: LoopVerifyPromptResult

| Field             | Type                |
| ----------------- | ------------------- |
| `passed`          | `boolean`           |
| `reason`          | `string`            |
| `verifierAgentId` | `string?`           |
| `startedAt`       | `string` (ISO 8601) |
| `completedAt`     | `string` (ISO 8601) |

---

## 6. Project Registry

**Path:** `$PASEO_HOME/projects/projects.json`

Array of project records.

| Field         | Type                        | Description                              |
| ------------- | --------------------------- | ---------------------------------------- |
| `projectId`   | `string`                    | Primary key                              |
| `rootPath`    | `string`                    | Filesystem root of the project           |
| `kind`        | `"git" \| "non_git"`        |                                          |
| `displayName` | `string`                    |                                          |
| `createdAt`   | `string` (ISO 8601)         |                                          |
| `updatedAt`   | `string` (ISO 8601)         |                                          |
| `archivedAt`  | `string \| null` (ISO 8601) | Soft-delete timestamp; required nullable |

Active git projects are unique by normalized `rootPath`. Startup reconciliation repairs older bad
states by moving workspaces from duplicate path-keyed projects onto the canonical project,
preferring remote-keyed project IDs such as `remote:github.com/owner/repo`, then archiving the
emptied duplicate.

---

## 7. Workspace Registry

**Path:** `$PASEO_HOME/projects/workspaces.json`

Array of workspace records. A workspace is a specific working directory within a project.

| Field         | Type                                            | Description                                                                                                                                                                           |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | `string`                                        | Opaque stable identifier (`wks_<hex>`), generated independently of the directory. MUST NOT be treated as a path; compare by exact equality. Use the `cwd` field for directory access. |
| `projectId`   | `string`                                        | FK to Project.projectId                                                                                                                                                               |
| `cwd`         | `string`                                        | Filesystem path                                                                                                                                                                       |
| `kind`        | `"local_checkout" \| "worktree" \| "directory"` |                                                                                                                                                                                       |
| `displayName` | `string`                                        | The human name (the generated/derived title). Decoupled from `branch` by construction.                                                                                                |
| `title`       | `string \| null`                                | User-set name override layered over `displayName`. Null means "use `displayName`".                                                                                                    |
| `branch`      | `string \| null`                                | The worktree's git branch. Separate from `displayName`/`title`; only worktree workspaces set it. A branch rename writes this and never the name.                                      |
| `createdAt`   | `string` (ISO 8601)                             |                                                                                                                                                                                       |
| `updatedAt`   | `string` (ISO 8601)                             |                                                                                                                                                                                       |
| `archivedAt`  | `string \| null` (ISO 8601)                     | Soft-delete; required nullable                                                                                                                                                        |

> **Opaque-ID invariant:** `workspaceId` is opaque identity, never a filesystem path. Filesystem and git operations take `cwd`/`workspaceDirectory` only — never the id. Path-derived grouping keys (e.g. `deriveWorkspaceDirectoryKey`, used at bootstrap to group agents into a workspace) are directory keys, not workspace identity, and must not be persisted or compared as ids.

---

## 8. Push Token Store

**Path:** `$PASEO_HOME/push-tokens.json`

```json
{
  "tokens": ["ExponentPushToken[...]", ...]
}
```

Simple set of Expo push notification tokens. Loaded with permissive parsing (filters non-string entries). Persisted with atomic temp-file rename.

---

## 9. Daemon meta files

These small files are not validated as full Zod schemas but are persisted under `$PASEO_HOME` for daemon identity and runtime coordination.

| Path                  | Format                                                         | Notes                                                                             |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `server-id`           | Plain text, e.g. `srv_<base64url>`                             | Stable per-`$PASEO_HOME` daemon ID. Overridable via `PASEO_SERVER_ID` env.        |
| `daemon-keypair.json` | `{ v: 2, publicKeyB64, secretKeyB64 }` (libsodium box keypair) | E2EE relay identity. Written with mode `0600`. Regenerated if file is unreadable. |
| `paseo.pid`           | JSON `{ pid, startedAt, ... }`                                 | PID lock; prevents two daemons sharing one `$PASEO_HOME`.                         |
| `daemon.log`          | Pino log output                                                | Default location; path/rotation configurable via `log.file` in `config.json`.     |

---

## Client-side stores (App)

These live in React Native `AsyncStorage` or browser `IndexedDB`, not on the daemon filesystem.

### Keying convention: directory-backed vs workspace-owned

Right-sidebar client state splits on whether it is determined by the directory or owned by the workspace (two workspaces can share one `cwd`). The split is enforced by the cache key, so changing a key changes the sharing semantics — see [architecture.md](architecture.md#right-sidebar-boundary-directory-backed-vs-workspace-owned) for the full table.

- **Directory-backed** (shared by same-`cwd` workspaces): keyed by `(serverId, cwd)`. Git status/diff, GitHub PR status, PR timeline, file preview content. These are TanStack Query caches, not persisted stores.
- **Workspace-owned** (independent per workspace): keyed by `workspaceId`, with `cwd` used only as a fallback when no `workspaceId` is present. Review draft comments (`@paseo:review-draft-store`), diff-mode overrides (in-memory), workspace composer attachments, and file-explorer nav/expand state. The `workspaceId` part of these keys is **opaque** — never parse it back into a path.

### Draft Store

**AsyncStorage key:** `paseo-drafts` (version 2)

```typescript
{
  drafts: Record<draftKey, {
    input: { text: string, images: AttachmentMetadata[] },
    lifecycle: "active" | "abandoned" | "sent",
    updatedAt: number,     // epoch ms
    version: number        // optimistic concurrency
  }>,
  createModalDraft: DraftRecord | null
}
```

### Attachment Store (Web)

**IndexedDB database:** `paseo-attachment-bytes`, object store: `attachments`

Stores binary attachment blobs keyed by attachment ID.

### AttachmentMetadata

| Field         | Type      | Description                    |
| ------------- | --------- | ------------------------------ |
| `id`          | `string`  | Unique attachment ID           |
| `mimeType`    | `string`  | MIME type                      |
| `storageType` | `string`  | Storage backend identifier     |
| `storageKey`  | `string`  | Key within the storage backend |
| `createdAt`   | `number`  | Epoch ms                       |
| `fileName`    | `string?` | Original filename              |
| `byteSize`    | `number?` | Size in bytes                  |
