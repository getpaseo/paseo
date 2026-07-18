# Data Model

## Project identity

Projects are allocated for the exact root selected by the caller, normalized lexically with `path.resolve` (never `realpath`). New project IDs are opaque `prj_<16 hex>` values. Existing remote-shaped or path-shaped IDs are retained as readable compatibility records and are never rekeyed. An active exact root is idempotent; archived-only matches do not resurrect an old project. Workspace `projectId` is stable membership: reconciliation may update git-derived kind and branch metadata, but never rehomes a workspace or changes a project's root, ID, or default name.

`kind` is mutable metadata, not identity. Workspace reconciliation watches active project roots and
updates only a project's `kind` and `updatedAt` when `.git` appears or disappears, preserving its
ID, root path, names, and workspace foreign keys. Attached workspaces are independently refreshed
from their own cwd, so an explicit project root never implies a workspace checkout. Empty projects
are observed too.

The workspace registry model defines placement once: initial directory/worktree construction,
mutable reconciliation fields, and the persisted-to-wire checkout projection. Its update policy
preserves `displayName` and `baseBranch`. `WorkspaceProvisioningService` owns the corresponding
registry writes, so directory opens, agent imports, and worktree creation all enter through that
service instead of constructing records independently. The workspace record is then the durable
placement authority: `cwd` is the exact execution directory, while `worktreeRoot` is the backing
checkout root. They intentionally differ for an exact subproject inside a worktree. Archive,
restore, branch auto-name, and descriptor flows consume those persisted facts rather than
rediscovering ownership from a directory that may already be gone. Reconciliation may refresh
mutable placement facts, but never changes `projectId`, `cwd`, `displayName`, or `baseBranch`.
Workspace archive runs lifecycle teardown from the exact `cwd` but removes only the backing
`worktreeRoot` after its last active reference disappears. Worktree recovery recreates that backing
checkout from `mainRepoRoot`, then restores the relative path from `worktreeRoot` to `cwd`.

Paseo uses **file-based JSON persistence** instead of a traditional database. All data is validated at runtime with Zod schemas. Most stores write atomically (write to temp file, then rename); a few still use plain `writeFile` — see each section. There is no schema-versioning/migration framework — schemas rely on optional fields with defaults for forward compatibility, with a small amount of inline normalization in `persisted-config.ts` for legacy provider/speech entries.

All server-side stores live under `$PASEO_HOME` (defaults to `~/.paseo`).

## Store Surface Rules

Store APIs own persistence atomicity and should not make services coordinate raw reads and writes. A good store method maps cleanly to one SQL statement or one SQL transaction, even when the current implementation is JSON files. If a caller needs a queue, lock, read-merge-write loop, or uniqueness race workaround, that behavior belongs behind the store surface.

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
├── runtime/
│   └── managed-processes/
│       └── {recordId}.json              # Helper processes owned by Paseo; reconciled on daemon bootstrap
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
| `labels`             | `Record<string, string>`                 | Key-value labels (default `{}`). `paseo.parent-agent-id` is set automatically for agent-scoped creation and removed by detach — see [agent-lifecycle.md](./agent-lifecycle.md)                                                                                                                                                                                                      |
| `lastStatus`         | `AgentStatus`                            | One of: `"initializing"`, `"idle"`, `"running"`, `"error"`, `"closed"`. `closed` means the record is resumable but has no live provider runtime; archive remains represented separately by `archivedAt`.                                                                                                                                                                            |
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
    trustedProxies: true | string[], // defaults to ["loopback"]; Express proxy names/CIDRs
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
    openai: {
      apiKey?: string,
      baseUrl?: string,
      stt?: { apiKey?: string, baseUrl?: string },
      tts?: { apiKey?: string, baseUrl?: string }
    },
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

Set these to select OpenAI instead of local speech:

| Env var                        | Applies to                      |
| ------------------------------ | ------------------------------- |
| `PASEO_VOICE_STT_PROVIDER`     | Voice mode STT provider         |
| `PASEO_DICTATION_STT_PROVIDER` | Composer dictation STT provider |
| `PASEO_VOICE_TTS_PROVIDER`     | Voice mode TTS provider         |

OpenAI speech can be configured under `providers.openai`. STT and TTS resolve independently, so they can point at different endpoints:

```json
{
  "providers": {
    "openai": {
      "stt": {
        "apiKey": "sk-...",
        "baseUrl": "https://stt.example.com/v1"
      },
      "tts": {
        "apiKey": "sk-...",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  }
}
```

`providers.openai.stt` is used for both composer dictation and voice mode speech-to-text; `providers.openai.tts` is used for voice mode text-to-speech. The equivalent env vars are `OPENAI_STT_API_KEY`/`OPENAI_STT_BASE_URL` and `OPENAI_TTS_API_KEY`/`OPENAI_TTS_BASE_URL`. Each feature falls back to `providers.openai.apiKey`/`providers.openai.baseUrl`, then `OPENAI_API_KEY`/`OPENAI_BASE_URL`, when its own fields are unset. These settings apply only to Paseo OpenAI speech features, not to Codex or other OpenAI-backed tools.

Paseo uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

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

- `{ type: "cron", expression: string, timezone?: string }` — canonical cadence for new writes; absent `timezone` means UTC
- `{ type: "every", everyMs: number }` — legacy rolling interval, still readable and executable during the compatibility window

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

| Field         | Type                        | Description                                                                      |
| ------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `projectId`   | `string`                    | Primary key; new records use opaque `prj_<16 hex>` IDs                           |
| `rootPath`    | `string`                    | Exact lexically normalized selected root; never realpathed                       |
| `kind`        | `"git" \| "non_git"`        | Mutable Git observation about `rootPath`, never a membership key                 |
| `displayName` | `string`                    | Selected-root basename, stable across remote and Git changes                     |
| `customName`  | `string \| null`            | User-set override layered over `displayName`. Null means "use the derived name". |
| `createdAt`   | `string` (ISO 8601)         |                                                                                  |
| `updatedAt`   | `string` (ISO 8601)         |                                                                                  |
| `archivedAt`  | `string \| null` (ISO 8601) | Soft-delete timestamp; required nullable                                         |

Active exact roots are idempotent using lexical platform-equivalence semantics. Existing legacy
remote-shaped and path-shaped IDs remain readable, including duplicate roots; reconciliation never
merges them, transfers names, archives them, or moves workspace foreign keys. An explicit
workspace `projectId` is authoritative when it names an active project, regardless of cwd
containment. Archived-only exact-root records are not resurrected by explicit add/open; a fresh
opaque project is allocated instead. Agent restore is separate and restores the agent's existing
workspace together with its owning project.

---

## 7. Workspace Registry

**Path:** `$PASEO_HOME/projects/workspaces.json`

Array of workspace records. A workspace is a specific working directory within a project.

| Field                  | Type                                            | Description                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId`          | `string`                                        | Opaque stable identifier (`wks_<hex>`), generated independently of the directory. MUST NOT be treated as a path; compare by exact equality. Use the `cwd` field for directory access. |
| `projectId`            | `string`                                        | FK to Project.projectId; the workspace's stable project membership                                                                                                                    |
| `cwd`                  | `string`                                        | Exact execution directory selected for agents, files, scripts, and setup                                                                                                              |
| `kind`                 | `"local_checkout" \| "worktree" \| "directory"` | Mutable checkout classification                                                                                                                                                       |
| `displayName`          | `string`                                        | The human name (the generated/derived title). Decoupled from `branch` by construction.                                                                                                |
| `title`                | `string \| null`                                | User-set name override layered over `displayName`. Null means "use `displayName`".                                                                                                    |
| `branch`               | `string \| null`                                | The current Git branch for git-backed workspaces. Separate from `displayName`/`title`; a background branch refresh never rewrites the name.                                           |
| `worktreeRoot`         | `string \| null`                                | Backing checkout/worktree root. May differ from `cwd` for exact subprojects and remains persisted after the worktree is deleted so restore can reproduce the placement.               |
| `baseBranch`           | `string \| null`                                | Normalized branch the Paseo worktree was created from; null for directories, local checkouts, and checkout-branch worktrees                                                           |
| `isPaseoOwnedWorktree` | `boolean`                                       | Whether Paseo owns and may remove/recreate the backing `worktreeRoot`                                                                                                                 |
| `mainRepoRoot`         | `string \| null`                                | Main repository root for worktree checkouts, independent of both exact `cwd` and backing `worktreeRoot`                                                                               |
| `createdAt`            | `string` (ISO 8601)                             |                                                                                                                                                                                       |
| `updatedAt`            | `string` (ISO 8601)                             |                                                                                                                                                                                       |
| `archivedAt`           | `string \| null` (ISO 8601)                     | Soft-delete; required nullable                                                                                                                                                        |
| `pinnedAt`             | `string \| null` (ISO 8601)                     | Pinned-to-top-of-sidebar timestamp; null means "not pinned"                                                                                                                           |

> **Opaque-ID invariant:** `workspaceId` is opaque identity, never a filesystem path. Filesystem and git operations take `cwd`/`workspaceDirectory` only — never the id. A compatibility-only first-materialization bootstrap still groups pre-registry agent records by path and Git remote so existing installs retain their legacy records. That grouping never runs against a live registry, and its keys are not runtime project or workspace identity.

`projectId` is still a real FK: workspace records should have a matching project record. Read-only
history surfaces tolerate transient orphaned workspaces by omitting those rows so one bad FK cannot
blank the whole History screen, but mutation paths should repair or remove the orphaned state rather
than treating it as valid.

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
