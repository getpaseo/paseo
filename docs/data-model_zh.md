# 数据模型

Paseo 使用**基于文件的 JSON 持久化**，而非传统数据库。所有数据在运行时通过 Zod schema 进行校验。大多数存储采用原子写入（先写入临时文件，再重命名）；少数仍使用普通的 `writeFile` —— 详见各节。没有 schema 版本管理/迁移框架 —— schema 依靠带默认值的可选字段实现向前兼容，并在 `persisted-config.ts` 中有少量内联规范化处理，用于兼容旧版 provider/speech 条目。

所有服务端存储位于 `$PASEO_HOME` 下（默认为 `~/.paseo`）。

---

## 目录布局

```
$PASEO_HOME/
├── config.json                          # 守护进程配置
├── server-id                            # 稳定的守护进程标识符（纯文本，"srv_<base64url>"）
├── daemon-keypair.json                  # 用于中继的端到端加密密钥对（权限 0600）
├── paseo.pid                            # 守护进程 PID 锁文件
├── daemon.log                           # 默认日志文件（路径可配置）
├── agents/
│   └── {sanitized-cwd}/
│       └── {agentId}.json               # 每个 agent 一个文件
├── schedules/
│   └── {scheduleId}.json                # 每个定时任务一个文件
├── chat/
│   └── rooms.json                       # 所有聊天室 + 消息
├── loops/
│   └── loops.json                       # 所有循环记录
├── projects/
│   ├── projects.json                    # 项目注册表
│   └── workspaces.json                  # 工作区注册表
├── runtime/
│   └── managed-processes/
│       └── {recordId}.json              # Paseo 管理的辅助进程；在守护进程启动时进行协调
└── push-tokens.json                     # Expo 推送通知令牌
```

`agents/{sanitized-cwd}/` 目录名由 agent 的 `cwd` 派生而来：去除文件系统根路径，并将路径分隔符替换为 `-`（Windows 驱动器字母变为 `C-` 风格的前缀）。持久化的服务端存储通过在目标目录中写入临时文件然后重命名到位来实现原子写入。

---

## 1. Agent Record（Agent 记录）

**路径：** `$PASEO_HOME/agents/{project-dir}/{agentId}.json`

每个 agent 存储为单独的 JSON 文件，按项目目录分组。

| 字段                 | 类型                                      | 描述                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                 | `string`                                  | UUID，主键                                                                                                                                                                                                                                                                                                                                             |
| `provider`           | `string`                                  | Agent 提供商（`"claude"`、`"codex"`、`"opencode"` 等）                                                                                                                                                                                                                                                                                                 |
| `cwd`                | `string`                                  | agent 运行的工作目录                                                                                                                                                                                                                                                                                                                                   |
| `workspaceId`        | `string?`                                 | 所属工作区 ID —— 所有权的唯一来源。每个 agent 在创建时都会打上一个 `workspaceId`；仅通过 `migrations/backfill-workspace-id.migration.ts` 对旧版仅有 cwd 的记录进行一次回填（这是唯一存在 cwd→id 映射的地方）。运行时代码绝不通过 cwd 推断所有权或状态：状态按 `workspaceId` 计算，同 cwd 的兄弟 agent 彼此独立。                                            |
| `createdAt`          | `string`（ISO 8601）                      | 创建时间戳                                                                                                                                                                                                                                                                                                                                             |
| `updatedAt`          | `string`（ISO 8601）                      | 最后更新时间戳                                                                                                                                                                                                                                                                                                                                         |
| `lastActivityAt`     | `string?`（ISO 8601）                     | 最后活动时间戳                                                                                                                                                                                                                                                                                                                                         |
| `lastUserMessageAt`  | `string?`（ISO 8601）                     | 最后用户消息时间戳                                                                                                                                                                                                                                                                                                                                     |
| `title`              | `string?`                                 | 用户可见的标题                                                                                                                                                                                                                                                                                                                                         |
| `labels`             | `Record<string, string>`                  | 键值标签（默认 `{}`）。`paseo.parent-agent-id` 会为 `create_agent` 子 agent 关系自动设置 —— 参见 [agent-lifecycle.md](./agent-lifecycle.md)                                                                                                                                                                                                              |
| `lastStatus`         | `AgentStatus`                             | 取值之一：`"initializing"`、`"idle"`、`"running"`、`"error"`、`"closed"`                                                                                                                                                                                                                                                                               |
| `lastModeId`         | `string?`                                 | 最后活跃的模式 ID                                                                                                                                                                                                                                                                                                                                      |
| `config`             | `SerializableConfig?`                     | Agent 会话配置（见下文）                                                                                                                                                                                                                                                                                                                               |
| `runtimeInfo`        | `RuntimeInfo?`                            | 实时运行时状态（见下文）                                                                                                                                                                                                                                                                                                                               |
| `features`           | `AgentFeature[]?`                         | 提供商报告的特性（开关/选择）                                                                                                                                                                                                                                                                                                                          |
| `persistence`        | `PersistenceHandle?`                      | 用于恢复会话的句柄                                                                                                                                                                                                                                                                                                                                     |
| `lastError`          | `string?`（可为 null）                    | 最后的错误消息（如有）                                                                                                                                                                                                                                                                                                                                 |
| `requiresAttention`  | `boolean?`                                | agent 是否需要用户关注                                                                                                                                                                                                                                                                                                                                 |
| `attentionReason`    | `"finished" \| "error" \| "permission"?`  | 需要关注的原因                                                                                                                                                                                                                                                                                                                                         |
| `attentionTimestamp` | `string?`（ISO 8601）                     | 标记关注的时间                                                                                                                                                                                                                                                                                                                                         |
| `internal`           | `boolean?`                                | 是否为系统内部 agent（循环工作 agent 等）                                                                                                                                                                                                                                                                                                              |
| `archivedAt`         | `string?`（ISO 8601）                     | 软删除时间戳                                                                                                                                                                                                                                                                                                                                           |

### 嵌套类型：SerializableConfig

| 字段                | 类型                        | 描述                |
| ------------------- | --------------------------- | ------------------- |
| `title`             | `string?`                   | 配置的标题          |
| `modeId`            | `string?`                   | 配置的模式          |
| `model`             | `string?`                   | 配置的模型          |
| `thinkingOptionId`  | `string?`                   | 思考/推理级别       |
| `featureValues`     | `Record<string, unknown>?`  | 特性偏好覆盖        |
| `extra`             | `Record<string, any>?`      | 提供商特定配置      |
| `systemPrompt`      | `string?`                   | 自定义系统提示词    |
| `mcpServers`        | `Record<string, any>?`      | MCP 服务器配置      |

### 嵌套类型：RuntimeInfo

| 字段                | 类型                        | 描述                  |
| ------------------- | --------------------------- | --------------------- |
| `provider`          | `string`                    | 活跃的提供商          |
| `sessionId`         | `string?`                   | 活跃的会话 ID         |
| `model`             | `string?`                   | 活跃的模型            |
| `thinkingOptionId`  | `string?`                   | 活跃的推理选项        |
| `modeId`            | `string?`                   | 活跃的模式            |
| `extra`             | `Record<string, unknown>?`  | 提供商特定运行时数据  |

### 嵌套类型：PersistenceHandle

| 字段            | 类型                    | 描述                                                        |
| --------------- | ----------------------- | ----------------------------------------------------------- |
| `provider`      | `string`                | 拥有该会话的提供商                                          |
| `sessionId`     | `string`                | 用于恢复的会话 ID                                           |
| `nativeHandle`  | `any?`                  | 提供商特定句柄（Codex 线程 ID、Claude 恢复令牌等）          |
| `metadata`      | `Record<string, any>?`  | 额外元数据                                                  |

### 嵌套类型：AgentFeature（基于 `type` 的可辨识联合类型）

**Toggle（开关）：**

| 字段          | 类型       |
| ------------- | ---------- |
| `type`        | `"toggle"` |
| `id`          | `string`   |
| `label`       | `string`   |
| `description` | `string?`  |
| `tooltip`     | `string?`  |
| `icon`        | `string?`  |
| `value`       | `boolean`  |

**Select（选择）：**

| 字段          | 类型                   |
| ------------- | ---------------------- |
| `type`        | `"select"`             |
| `id`          | `string`               |
| `label`       | `string`               |
| `description` | `string?`              |
| `tooltip`     | `string?`              |
| `icon`        | `string?`              |
| `value`       | `string \| null`       |
| `options`     | `AgentSelectOption[]`  |

---

## 仅运行时的终端会话

终端是守护进程的实时状态，而非持久化的 JSON 记录。终端在运行期间携带 `workspaceId`；按工作区筛选的终端列表仅包含具有匹配 `workspaceId` 的终端。没有所属者的旧版活动终端仍然对未限定工作区的终端读取可见，但不影响任何工作区状态。

终端活动按 **`workspaceId`** 计入工作区状态桶：正在工作的终端仅将其携带的工作区驱动为 `running` 状态。同 `cwd` 的兄弟 agent 不受影响；终端的可见性同样按 `workspaceId` 限定。

---

## 2. Daemon Configuration（守护进程配置）

**路径：** `$PASEO_HOME/config.json`

单个文件，通过 `PersistedConfigSchema` 校验。

```
{
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    hostnames: true | string[],   // 旧版别名 `allowedHosts` 会在加载时迁移
    trustedProxies: true | string[], // 默认为 ["loopback"]；Express 代理名称/CIDR
    mcp: { enabled: boolean, injectIntoAgents: boolean },
    appendSystemPrompt: string,    // 追加到支持的提供商的系统/开发者提示词中
    cors: { allowedOrigins: string[] },
    relay: { enabled: boolean, endpoint: string, publicEndpoint: string, useTls: boolean, publicUseTls: boolean },
    auth: { password: string }    // bcrypt 哈希，可选
  },
  app: {
    baseUrl: string
  },
  worktrees?: {
    root?: string            // 新工作树的根目录；默认为 $PASEO_HOME/worktrees
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
    // ProviderOverrideSchema；旧版包含 `command: { mode, ... }` 的条目
    // 会在加载时通过 `migrateProviderSettings` 迁移为当前形态。
    // 自定义 provider ID 必须声明 `extends`（内置之一或 `"acp"`）和 `label`。
    // 参见 `provider-launch-config.ts`。
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

所有字段均为可选，具有合理的默认值。

`agents.metadataGeneration.providers` 控制守护进程端元数据任务（如提交消息、PR 文本、分支名称和生成的 agent 标题）的首选结构化生成回退顺序。条目首先按配置顺序尝试，然后 Paseo 回退到动态发现的默认值，最后使用当前可用的选项。

本地语音模型 ID 有意限制范围：STT 使用 `parakeet-tdt-0.6b-v2-int8`，TTS 使用 `kokoro-en-v0_19`，轮次检测使用内置的 Silero VAD 模型。

设置以下环境变量以选择 OpenAI 而非本地语音：

| 环境变量                        | 适用场景                        |
| ------------------------------- | ------------------------------- |
| `PASEO_VOICE_STT_PROVIDER`      | 语音模式 STT 提供商             |
| `PASEO_DICTATION_STT_PROVIDER`  | 编辑器听写 STT 提供商           |
| `PASEO_VOICE_TTS_PROVIDER`      | 语音模式 TTS 提供商             |

OpenAI 语音可在 `providers.openai` 下配置。STT 和 TTS 独立解析，因此它们可以指向不同的端点：

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

`providers.openai.stt` 同时用于编辑器听写和语音模式的语音转文字；`providers.openai.tts` 用于语音模式的文字转语音。等效的环境变量为 `OPENAI_STT_API_KEY`/`OPENAI_STT_BASE_URL` 和 `OPENAI_TTS_API_KEY`/`OPENAI_TTS_BASE_URL`。当各功能自身的字段未设置时，会依次回退到 `providers.openai.apiKey`/`providers.openai.baseUrl`，然后是 `OPENAI_API_KEY`/`OPENAI_BASE_URL`。这些设置仅适用于 Paseo 的 OpenAI 语音功能，不影响 Codex 或其他基于 OpenAI 的工具。

Paseo 在配置的 OpenAI 基础 URL 下使用以下路径：

- 听写 STT：`/v1/audio/transcriptions`
- 语音模式 STT：`/v1/audio/transcriptions`
- 语音模式 TTS：`/v1/audio/speech`

---

## 3. Schedule（定时任务）

**路径：** `$PASEO_HOME/schedules/{id}.json`

每个定时任务一个文件。ID 为 8 个十六进制字符。

| 字段        | 类型                                   | 描述                       |
| ----------- | -------------------------------------- | -------------------------- |
| `id`        | `string`                               | 8 字符十六进制 ID          |
| `name`      | `string?`                              | 人类可读的名称             |
| `prompt`    | `string`                               | 要发送的提示词             |
| `cadence`   | `ScheduleCadence`                      | 时间安排（见下文）         |
| `target`    | `ScheduleTarget`                       | 运行目标（见下文）         |
| `status`    | `"active" \| "paused" \| "completed"`  | 当前状态                   |
| `createdAt` | `string`（ISO 8601）                   |                            |
| `updatedAt` | `string`（ISO 8601）                   |                            |
| `nextRunAt` | `string?`（ISO 8601）                  | 下次计划的执行时间         |
| `lastRunAt` | `string?`（ISO 8601）                  | 上次执行时间               |
| `pausedAt`  | `string?`（ISO 8601）                  | 暂停时间                   |
| `expiresAt` | `string?`（ISO 8601）                  | 自动过期时间               |
| `maxRuns`   | `number?`                              | 完成前的最大执行次数       |
| `runs`      | `ScheduleRun[]`                        | 执行历史                   |

### 嵌套类型：ScheduleCadence（基于 `type` 的可辨识联合类型）

- `{ type: "every", everyMs: number }` — 毫秒级间隔
- `{ type: "cron", expression: string, timezone?: string }` — cron 表达式；缺省 `timezone` 表示 UTC，如提供则为 IANA 时区，用于本地时钟时间重复

### 嵌套类型：ScheduleTarget（基于 `type` 的可辨识联合类型）

- `{ type: "agent", agentId: string }` — 发送到已有 agent
- `{ type: "new-agent", config: { provider, cwd, modeId?, model?, thinkingOptionId?, title?, approvalPolicy?, sandboxMode?, networkAccess?, webSearch?, extra?, systemPrompt?, mcpServers? } }` — 创建一个新 agent

### 嵌套类型：ScheduleRun

| 字段            | 类型                                    | 描述               |
| --------------- | --------------------------------------- | ------------------ |
| `id`            | `string`                                | 运行 ID            |
| `scheduledFor`  | `string`（ISO 8601）                    | 计划的执行时间     |
| `startedAt`     | `string`（ISO 8601）                    |                    |
| `endedAt`       | `string?`（ISO 8601）                   |                    |
| `status`        | `"running" \| "succeeded" \| "failed"`  |                    |
| `agentId`       | `string?`（UUID）                       | 本次运行使用的 agent |
| `output`        | `string?`                               | agent 输出文本     |
| `error`         | `string?`                               | 失败时的错误消息   |

---

## 4. Chat（聊天）

**路径：** `$PASEO_HOME/chat/rooms.json`

单个文件，包含所有聊天室和消息。

```json
{
  "rooms": [ ... ],
  "messages": [ ... ]
}
```

### ChatRoom

| 字段        | 类型                 | 描述                             |
| ----------- | -------------------- | -------------------------------- |
| `id`        | `string`（UUID）     |                                  |
| `name`      | `string`             | 唯一的聊天室名称（不区分大小写） |
| `purpose`   | `string?`            | 聊天室描述                       |
| `createdAt` | `string`（ISO 8601） |                                  |
| `updatedAt` | `string`（ISO 8601） | 每次新消息时更新                 |

### ChatMessage

| 字段                | 类型                 | 描述                              |
| ------------------- | -------------------- | --------------------------------- |
| `id`                | `string`（UUID）     |                                   |
| `roomId`            | `string`             | 外键，指向 ChatRoom.id            |
| `authorAgentId`     | `string`             | 作者的 agent ID                   |
| `body`              | `string`             | 消息文本（支持 `@mentions`）      |
| `replyToMessageId`  | `string?`            | 外键，指向另一条 ChatMessage.id   |
| `mentionAgentIds`   | `string[]`           | 提取出的 `@mention` agent ID 列表 |
| `createdAt`         | `string`（ISO 8601） |                                   |

---

## 5. Loop（循环）

**路径：** `$PASEO_HOME/loops/loops.json`

单个文件，包含所有循环记录的数组。写入为直接写入（非原子），并通过内存队列序列化。在守护进程启动时，任何 `status: "running"` 的记录会被恢复为 `"stopped"` 并添加一条中断日志条目。

| 字段                     | 类型                                                 | 描述                            |
| ------------------------ | ---------------------------------------------------- | ------------------------------- |
| `id`                     | `string`                                             | 8 字符 UUID 前缀                |
| `name`                   | `string?`                                            | 人类可读的名称                  |
| `prompt`                 | `string`                                             | 工作 agent 的提示词             |
| `cwd`                    | `string`                                             | 工作目录                        |
| `provider`               | `string`                                             | 默认提供商                      |
| `model`                  | `string?`                                            | 默认模型                        |
| `modeId`                 | `string?`                                            | 默认模式 ID                     |
| `workerProvider`         | `string?`                                            | 工作 agent 的提供商覆盖         |
| `workerModel`            | `string?`                                            | 工作 agent 的模型覆盖           |
| `verifierProvider`       | `string?`                                            | 验证 agent 的提供商覆盖         |
| `verifierModel`          | `string?`                                            | 验证 agent 的模型覆盖           |
| `verifierModeId`         | `string?`                                            | 验证 agent 的模式 ID 覆盖       |
| `verifyPrompt`           | `string?`                                            | LLM 验证提示词                  |
| `verifyChecks`           | `string[]`                                           | 作为检查运行的 shell 命令       |
| `archive`                | `boolean`                                            | 使用后是否归档工作 agent        |
| `sleepMs`                | `number`                                             | 迭代间的延迟（毫秒）            |
| `maxIterations`          | `number?`                                            | 迭代次数上限                    |
| `maxTimeMs`              | `number?`                                            | 总时间预算（毫秒）              |
| `status`                 | `"running" \| "succeeded" \| "failed" \| "stopped"`  |                                 |
| `createdAt`              | `string`（ISO 8601）                                 |                                 |
| `updatedAt`              | `string`（ISO 8601）                                 |                                 |
| `startedAt`              | `string`（ISO 8601）                                 |                                 |
| `completedAt`            | `string?`（ISO 8601）                                |                                 |
| `stopRequestedAt`        | `string?`（ISO 8601）                                |                                 |
| `iterations`             | `LoopIteration[]`                                    |                                 |
| `logs`                   | `LoopLogEntry[]`                                     |                                 |
| `nextLogSeq`             | `number`                                             | 单调递增的日志序号计数器        |
| `activeIteration`        | `number?`                                            | 当前正在执行的迭代索引          |
| `activeWorkerAgentId`    | `string?`                                            | 当前正在运行的工作 agent        |
| `activeVerifierAgentId`  | `string?`                                            | 当前正在运行的验证 agent        |

### 嵌套类型：LoopIteration

| 字段                 | 类型                                                 | 描述                   |
| -------------------- | ---------------------------------------------------- | ---------------------- |
| `index`              | `number`                                             | 从 1 开始的迭代索引    |
| `workerAgentId`      | `string?`                                            | 工作 agent 的 ID       |
| `workerStartedAt`    | `string`（ISO 8601）                                 |                        |
| `workerCompletedAt`  | `string?`（ISO 8601）                                |                        |
| `verifierAgentId`    | `string?`                                            | 验证 agent 的 ID       |
| `status`             | `"running" \| "succeeded" \| "failed" \| "stopped"`  |                        |
| `workerOutcome`      | `"completed" \| "failed" \| "canceled"?`             |                        |
| `failureReason`      | `string?`                                            |                        |
| `verifyChecks`       | `LoopVerifyCheckResult[]`                            | Shell 检查结果         |
| `verifyPrompt`       | `LoopVerifyPromptResult?`                            | LLM 验证结果           |

### 嵌套类型：LoopLogEntry

| 字段        | 类型                                                  |
| ----------- | ----------------------------------------------------- |
| `seq`       | `number`（单调递增）                                  |
| `timestamp` | `string`（ISO 8601）                                  |
| `iteration` | `number?`                                             |
| `source`    | `"loop" \| "worker" \| "verifier" \| "verify-check"`  |
| `level`     | `"info" \| "error"`                                   |
| `text`      | `string`                                              |

### 嵌套类型：LoopVerifyCheckResult

| 字段           | 类型                |
| -------------- | ------------------- |
| `command`      | `string`            |
| `exitCode`     | `number`            |
| `passed`       | `boolean`           |
| `stdout`       | `string`            |
| `stderr`       | `string`            |
| `startedAt`    | `string`（ISO 8601）|
| `completedAt`  | `string`（ISO 8601）|

### 嵌套类型：LoopVerifyPromptResult

| 字段               | 类型                |
| ------------------ | ------------------- |
| `passed`           | `boolean`           |
| `reason`           | `string`            |
| `verifierAgentId`  | `string?`           |
| `startedAt`        | `string`（ISO 8601）|
| `completedAt`      | `string`（ISO 8601）|

---

## 6. Project Registry（项目注册表）

**路径：** `$PASEO_HOME/projects/projects.json`

项目记录数组。

| 字段          | 类型                         | 描述                             |
| ------------- | ---------------------------- | -------------------------------- |
| `projectId`   | `string`                     | 主键                             |
| `rootPath`    | `string`                     | 项目的文件系统根路径             |
| `kind`        | `"git" \| "non_git"`         |                                  |
| `displayName` | `string`                     |                                  |
| `createdAt`   | `string`（ISO 8601）         |                                  |
| `updatedAt`   | `string`（ISO 8601）         |                                  |
| `archivedAt`  | `string \| null`（ISO 8601） | 软删除时间戳；必填但可为 null    |

活跃的 git 项目按规范化的 `rootPath` 唯一。启动时的协调会修复旧的错误状态：将重复路径键控项目的工作区迁移到规范项目上（优先使用远程键控的项目 ID，如 `remote:github.com/owner/repo`），然后归档清空的重复项。

---

## 7. Workspace Registry（工作区注册表）

**路径：** `$PASEO_HOME/projects/workspaces.json`

工作区记录数组。工作区是项目内的一个特定工作目录。

| 字段          | 类型                                             | 描述                                                                                                                                                           |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | `string`                                         | 不透明稳定标识符（`wks_<hex>`），独立于目录生成。不得将其视为路径；通过完全相等进行比较。使用 `cwd` 字段进行目录访问。                                         |
| `projectId`   | `string`                                         | 外键，指向 Project.projectId                                                                                                                                   |
| `cwd`         | `string`                                         | 文件系统路径                                                                                                                                                   |
| `kind`        | `"local_checkout" \| "worktree" \| "directory"`  |                                                                                                                                                                |
| `displayName` | `string`                                         | 人类可读名称（生成/派生的标题）。在构建时与 `branch` 解耦。                                                                                                    |
| `title`       | `string \| null`                                 | 用户设置的名称覆盖，叠加于 `displayName` 之上。null 表示"使用 `displayName`"。                                                                                  |
| `branch`      | `string \| null`                                 | 工作树的 git 分支。与 `displayName`/`title` 分离；仅工作树工作区会设置它。分支重命名只写入此字段，从不写入名称。                                               |
| `createdAt`   | `string`（ISO 8601）                             |                                                                                                                                                                |
| `updatedAt`   | `string`（ISO 8601）                             |                                                                                                                                                                |
| `archivedAt`  | `string \| null`（ISO 8601）                     | 软删除；必填但可为 null                                                                                                                                        |

> **不透明 ID 不变式：** `workspaceId` 是不透明标识，绝非文件系统路径。文件系统和 git 操作仅使用 `cwd`/`workspaceDirectory` —— 绝不使用该 ID。路径派生的分组键（如 `deriveWorkspaceDirectoryKey`，用于在启动时将 agent 分组到工作区）是目录键，而非工作区标识，不得作为 ID 持久化或比较。

`projectId` 仍然是真正的外键：工作区记录应有匹配的项目记录。只读的历史视图容忍暂时的孤立工作区，通过省略这些行来防止一个损坏的外键导致整个历史页面空白，但变更路径应修复或移除孤立状态，而非将其视为有效。

---

## 8. Push Token Store（推送令牌存储）

**路径：** `$PASEO_HOME/push-tokens.json`

```json
{
  "tokens": ["ExponentPushToken[...]", ...]
}
```

简单的 Expo 推送通知令牌集合。使用宽松解析加载（过滤掉非字符串条目）。通过原子临时文件重命名持久化。

---

## 9. Daemon meta files（守护进程元文件）

这些小型文件不作为完整 Zod schema 校验，但持久化在 `$PASEO_HOME` 下，用于守护进程身份和运行时协调。

| 路径                   | 格式                                                            | 说明                                                                     |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `server-id`            | 纯文本，例如 `srv_<base64url>`                                  | 每个 `$PASEO_HOME` 的稳定守护进程 ID。可通过 `PASEO_SERVER_ID` 环境变量覆盖。 |
| `daemon-keypair.json`  | `{ v: 2, publicKeyB64, secretKeyB64 }`（libsodium box 密钥对）   | 端到端加密中继身份。以权限 `0600` 写入。文件不可读时重新生成。              |
| `paseo.pid`            | JSON `{ pid, startedAt, ... }`                                  | PID 锁；防止两个守护进程共享同一个 `$PASEO_HOME`。                         |
| `daemon.log`           | Pino 日志输出                                                   | 默认位置；路径/轮转可通过 `config.json` 中的 `log.file` 配置。             |

---

## Client-side stores（客户端存储，App）

这些存储位于 React Native `AsyncStorage` 或浏览器 `IndexedDB` 中，不在守护进程文件系统上。

### 键控约定：目录绑定 vs 工作区拥有

右侧栏客户端状态根据是由目录决定还是由工作区拥有（两个工作区可以共享同一个 `cwd`）进行区分。这种区分通过缓存键强制执行，因此更改键会改变共享语义 —— 参见 [architecture.md](architecture.md#right-sidebar-boundary-directory-backed-vs-workspace-owned) 获取完整表格。

- **目录绑定**（由相同 `cwd` 的工作区共享）：键为 `(serverId, cwd)`。Git 状态/diff、GitHub PR 状态、PR 时间线、文件预览内容。这些是 TanStack Query 缓存，而非持久化存储。
- **工作区拥有**（每个工作区独立）：键为 `workspaceId`，仅在无 `workspaceId` 时使用 `cwd` 作为回退。评审草稿评论（`@paseo:review-draft-store`）、diff 模式覆盖（内存中）、工作区编辑器附件和文件浏览器导航/展开状态。这些键中的 `workspaceId` 部分是**不透明的** —— 绝不将其解析回路径。

### Draft Store（草稿存储）

**AsyncStorage 键：** `paseo-drafts`（版本 2）

```typescript
{
  drafts: Record<draftKey, {
    input: { text: string, images: AttachmentMetadata[] },
    lifecycle: "active" | "abandoned" | "sent",
    updatedAt: number,     // 纪元毫秒
    version: number        // 乐观并发控制
  }>,
  createModalDraft: DraftRecord | null
}
```

### Attachment Store（附件存储，Web）

**IndexedDB 数据库：** `paseo-attachment-bytes`，对象存储：`attachments`

按附件 ID 存储二进制附件 blob。

### AttachmentMetadata

| 字段          | 类型       | 描述                |
| ------------- | ---------- | ------------------- |
| `id`          | `string`   | 唯一附件 ID         |
| `mimeType`    | `string`   | MIME 类型           |
| `storageType` | `string`   | 存储后端标识符      |
| `storageKey`  | `string`   | 存储后端中的键      |
| `createdAt`   | `number`   | 纪元毫秒            |
| `fileName`    | `string?`  | 原始文件名          |
| `byteSize`    | `number?`  | 大小（字节）        |
