# Data Model

Paseo uses **file-based JSON persistence** instead of a traditional database. All data is validated at runtime with Zod schemas and written atomically (write to temp file, then rename). There are no migrations — schemas use optional fields with defaults for forward compatibility.

All server-side stores live under `$PASEO_HOME` (defaults to `~/.paseo`).

---

## Directory layout

```
$PASEO_HOME/
├── config.json                          # Daemon configuration
├── agents/
│   └── {project-dir}/
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

---

## 1. Agent Record

**Path:** `$PASEO_HOME/agents/{project-dir}/{agentId}.json`

Each agent is stored as a separate JSON file, grouped by project directory.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID, primary key |
| `provider` | `string` | Agent provider (`"claude"`, `"codex"`, `"opencode"`, etc.) |
| `cwd` | `string` | Working directory the agent operates in |
| `createdAt` | `string` (ISO 8601) | Creation timestamp |
| `updatedAt` | `string` (ISO 8601) | Last update timestamp |
| `lastActivityAt` | `string?` (ISO 8601) | Last activity timestamp |
| `lastUserMessageAt` | `string?` (ISO 8601) | Last user message timestamp |
| `title` | `string?` | User-visible title |
| `labels` | `Record<string, string>` | Key-value labels (default `{}`) |
| `lastStatus` | `AgentStatus` | One of: `"initializing"`, `"idle"`, `"running"`, `"error"`, `"closed"` |
| `lastModeId` | `string?` | Last active mode ID |
| `config` | `SerializableConfig?` | Agent session configuration (see below) |
| `runtimeInfo` | `RuntimeInfo?` | Live runtime state (see below) |
| `features` | `AgentFeature[]?` | Provider-reported features (toggles/selects) |
| `persistence` | `PersistenceHandle?` | Handle for resuming sessions |
| `requiresAttention` | `boolean?` | Whether the agent needs user attention |
| `attentionReason` | `"finished" \| "error" \| "permission"?` | Why attention is needed |
| `attentionTimestamp` | `string?` (ISO 8601) | When attention was flagged |
| `internal` | `boolean?` | Whether this is a system-internal agent (loop workers, etc.) |
| `archivedAt` | `string?` (ISO 8601) | Soft-delete timestamp |

### Nested: SerializableConfig

| Field | Type | Description |
|---|---|---|
| `title` | `string?` | Configured title |
| `modeId` | `string?` | Configured mode |
| `model` | `string?` | Configured model |
| `thinkingOptionId` | `string?` | Thinking/reasoning level |
| `featureValues` | `Record<string, unknown>?` | Feature preference overrides |
| `extra` | `Record<string, any>?` | Provider-specific config |
| `systemPrompt` | `string?` | Custom system prompt |
| `mcpServers` | `Record<string, any>?` | MCP server configurations |

### Nested: RuntimeInfo

| Field | Type | Description |
|---|---|---|
| `provider` | `string` | Active provider |
| `sessionId` | `string?` | Active session ID |
| `model` | `string?` | Active model |
| `thinkingOptionId` | `string?` | Active thinking option |
| `modeId` | `string?` | Active mode |
| `extra` | `Record<string, unknown>?` | Provider-specific runtime data |

### Nested: PersistenceHandle

| Field | Type | Description |
|---|---|---|
| `provider` | `string` | Provider that owns the session |
| `sessionId` | `string` | Session ID for resumption |
| `nativeHandle` | `any?` | Provider-specific handle (Codex thread ID, Claude resume token, etc.) |
| `metadata` | `Record<string, any>?` | Extra metadata |

### Nested: AgentFeature (discriminated union on `type`)

**Toggle:**

| Field | Type |
|---|---|
| `type` | `"toggle"` |
| `id` | `string` |
| `label` | `string` |
| `description` | `string?` |
| `tooltip` | `string?` |
| `icon` | `string?` |
| `value` | `boolean` |

**Select:**

| Field | Type |
|---|---|
| `type` | `"select"` |
| `id` | `string` |
| `label` | `string` |
| `description` | `string?` |
| `tooltip` | `string?` |
| `icon` | `string?` |
| `value` | `string?` |
| `options` | `AgentSelectOption[]` |

---

## 2. Daemon Configuration

**Path:** `$PASEO_HOME/config.json`

Single file, validated with `PersistedConfigSchema`.

```
{
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    hostnames: true | string[],
    mcp: { enabled: boolean },
    cors: { allowedOrigins: string[] },
    relay: { enabled: boolean, endpoint: string, publicEndpoint: string }
  },
  app: {
    baseUrl: string
  },
  providers: {
    openai: { apiKey: string },
    local: { modelsDir: string }
  },
  agents: {
    providers: {
      [provider: string]: {
        command: { mode: "default" } | { mode: "append", args: string[] } | { mode: "replace", argv: string[] },
        env: Record<string, string>
      }
    }
  },
  features: {
    dictation: { enabled, stt: { provider, model, confidenceThreshold } },
    voiceMode: { enabled, llm, stt, turnDetection, tts: { provider, model, voice, speakerId, speed } }
  },
  log: {
    level, format,
    console: { level, format },
    file: { level, path, rotate: { maxSize, maxFiles } }
  }
}
```

All fields are optional with sensible defaults.

---

## 3. Schedule

**Path:** `$PASEO_HOME/schedules/{id}.json`

One file per schedule. ID is 8 hex characters.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | 8-char hex ID |
| `name` | `string?` | Human-readable name |
| `prompt` | `string` | The prompt to send |
| `cadence` | `ScheduleCadence` | Timing (see below) |
| `target` | `ScheduleTarget` | What to run (see below) |
| `status` | `"active" \| "paused" \| "completed"` | Current state |
| `createdAt` | `string` (ISO 8601) | |
| `updatedAt` | `string` (ISO 8601) | |
| `nextRunAt` | `string?` (ISO 8601) | Next scheduled execution |
| `lastRunAt` | `string?` (ISO 8601) | Last execution time |
| `pausedAt` | `string?` (ISO 8601) | When paused |
| `expiresAt` | `string?` (ISO 8601) | Auto-expire time |
| `maxRuns` | `number?` | Max executions before completing |
| `runs` | `ScheduleRun[]` | Execution history |

### Nested: ScheduleCadence (discriminated union on `type`)

- `{ type: "every", everyMs: number }` — interval in milliseconds
- `{ type: "cron", expression: string }` — cron expression

### Nested: ScheduleTarget (discriminated union on `type`)

- `{ type: "agent", agentId: string }` — send to existing agent
- `{ type: "new-agent", config: { provider, cwd, modeId?, model?, thinkingOptionId?, title?, approvalPolicy?, sandboxMode?, networkAccess?, webSearch?, extra?, systemPrompt?, mcpServers? } }` — create a new agent

### Nested: ScheduleRun

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Run ID |
| `scheduledFor` | `string` (ISO 8601) | Intended execution time |
| `startedAt` | `string` (ISO 8601) | |
| `endedAt` | `string?` (ISO 8601) | |
| `status` | `"running" \| "succeeded" \| "failed"` | |
| `agentId` | `string?` (UUID) | Agent used for this run |
| `output` | `string?` | Agent output text |
| `error` | `string?` | Error message if failed |

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

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | |
| `name` | `string` | Unique room name (case-insensitive) |
| `purpose` | `string?` | Room description |
| `createdAt` | `string` (ISO 8601) | |
| `updatedAt` | `string` (ISO 8601) | Updated on each new message |

### ChatMessage

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | |
| `roomId` | `string` | FK to ChatRoom.id |
| `authorAgentId` | `string` | Agent ID of the author |
| `body` | `string` | Message text (supports `@mentions`) |
| `replyToMessageId` | `string?` | FK to another ChatMessage.id |
| `mentionAgentIds` | `string[]` | Extracted `@mention` agent IDs |
| `createdAt` | `string` (ISO 8601) | |

---

## 5. Loop

**Path:** `$PASEO_HOME/loops/loops.json`

Single file containing an array of all loop records.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | 8-char UUID prefix |
| `name` | `string?` | Human-readable name |
| `prompt` | `string` | Worker prompt |
| `cwd` | `string` | Working directory |
| `provider` | `string` | Default provider |
| `model` | `string?` | Default model |
| `workerProvider` | `string?` | Override provider for workers |
| `workerModel` | `string?` | Override model for workers |
| `verifierProvider` | `string?` | Override provider for verifiers |
| `verifierModel` | `string?` | Override model for verifiers |
| `verifyPrompt` | `string?` | LLM verification prompt |
| `verifyChecks` | `string[]` | Shell commands to run as checks |
| `archive` | `boolean` | Whether to archive worker agents after use |
| `sleepMs` | `number` | Delay between iterations (ms) |
| `maxIterations` | `number?` | Cap on iterations |
| `maxTimeMs` | `number?` | Total time budget (ms) |
| `status` | `"running" \| "succeeded" \| "failed" \| "stopped"` | |
| `createdAt` | `string` (ISO 8601) | |
| `updatedAt` | `string` (ISO 8601) | |
| `startedAt` | `string` (ISO 8601) | |
| `completedAt` | `string?` (ISO 8601) | |
| `stopRequestedAt` | `string?` (ISO 8601) | |
| `iterations` | `LoopIteration[]` | |
| `logs` | `LoopLogEntry[]` | |
| `nextLogSeq` | `number` | Monotonic log sequence counter |
| `activeIteration` | `number?` | Currently executing iteration index |
| `activeWorkerAgentId` | `string?` | Currently running worker agent |
| `activeVerifierAgentId` | `string?` | Currently running verifier agent |

### Nested: LoopIteration

| Field | Type | Description |
|---|---|---|
| `index` | `number` | 1-based iteration index |
| `workerAgentId` | `string?` | Agent ID of the worker |
| `workerStartedAt` | `string` (ISO 8601) | |
| `workerCompletedAt` | `string?` (ISO 8601) | |
| `verifierAgentId` | `string?` | Agent ID of the verifier |
| `status` | `"running" \| "succeeded" \| "failed" \| "stopped"` | |
| `workerOutcome` | `"completed" \| "failed" \| "canceled"?` | |
| `failureReason` | `string?` | |
| `verifyChecks` | `LoopVerifyCheckResult[]` | Shell check results |
| `verifyPrompt` | `LoopVerifyPromptResult?` | LLM verification result |

### Nested: LoopLogEntry

| Field | Type |
|---|---|
| `seq` | `number` (monotonic) |
| `timestamp` | `string` (ISO 8601) |
| `iteration` | `number?` |
| `source` | `"loop" \| "worker" \| "verifier" \| "verify-check"` |
| `level` | `"info" \| "error"` |
| `text` | `string` |

### Nested: LoopVerifyCheckResult

| Field | Type |
|---|---|
| `command` | `string` |
| `exitCode` | `number` |
| `passed` | `boolean` |
| `stdout` | `string` |
| `stderr` | `string` |
| `startedAt` | `string` (ISO 8601) |
| `completedAt` | `string` (ISO 8601) |

### Nested: LoopVerifyPromptResult

| Field | Type |
|---|---|
| `passed` | `boolean` |
| `reason` | `string` |
| `verifierAgentId` | `string?` |
| `startedAt` | `string` (ISO 8601) |
| `completedAt` | `string` (ISO 8601) |

---

## 6. Project Registry

**Path:** `$PASEO_HOME/projects/projects.json`

Array of project records.

| Field | Type | Description |
|---|---|---|
| `projectId` | `string` | Primary key |
| `rootPath` | `string` | Filesystem root of the project |
| `kind` | `"git" \| "non_git"` | |
| `displayName` | `string` | |
| `createdAt` | `string` (ISO 8601) | |
| `updatedAt` | `string` (ISO 8601) | |
| `archivedAt` | `string?` (ISO 8601) | Soft-delete timestamp |

---

## 7. Workspace Registry

**Path:** `$PASEO_HOME/projects/workspaces.json`

Array of workspace records. A workspace is a specific working directory within a project.

| Field | Type | Description |
|---|---|---|
| `workspaceId` | `string` | Primary key |
| `projectId` | `string` | FK to Project.projectId |
| `cwd` | `string` | Filesystem path |
| `kind` | `"local_checkout" \| "worktree" \| "directory"` | |
| `displayName` | `string` | |
| `createdAt` | `string` (ISO 8601) | |
| `updatedAt` | `string` (ISO 8601) | |
| `archivedAt` | `string?` (ISO 8601) | Soft-delete timestamp |

---

## 8. Push Token Store

**Path:** `$PASEO_HOME/push-tokens.json`

```json
{
  "tokens": ["ExponentPushToken[...]", ...]
}
```

Simple set of Expo push notification tokens. No schema validation — just an array of strings.

---

## Client-side stores (App)

These live in React Native `AsyncStorage` or browser `IndexedDB`, not on the daemon filesystem.

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

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique attachment ID |
| `mimeType` | `string` | MIME type |
| `storageType` | `string` | Storage backend identifier |
| `storageKey` | `string` | Key within the storage backend |
| `createdAt` | `number` | Epoch ms |
| `fileName` | `string?` | Original filename |
| `byteSize` | `number?` | Size in bytes |
