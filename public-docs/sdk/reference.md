---
title: SDK API reference
description: Public configuration, methods, handles, results, defaults, and lifecycle behavior for @getpaseo/client.
nav: API reference
order: 58
category: TypeScript SDK
---

# SDK API reference

Import every supported runtime value and TypeScript type from `@getpaseo/client`.

## `createPaseoClient(config)`

Creates a client without opening the connection.

Required configuration:

| Field | Type     | Meaning                                     |
| ----- | -------- | ------------------------------------------- |
| `url` | `string` | Daemon WebSocket endpoint, including `/ws`. |

Common optional configuration:

| Field                   | Type          | Default        | Meaning                                          |
| ----------------------- | ------------- | -------------- | ------------------------------------------------ |
| `clientId`              | `string`      | Generated      | Stable identifier for logs and subscriptions.    |
| `password`              | `string`      | Unset          | Daemon password.                                 |
| `authHeader`            | `string`      | Unset          | Complete authorization-header value for a proxy. |
| `connectTimeoutMs`      | `number`      | Client default | Connection deadline.                             |
| `reconnect.enabled`     | `boolean`     | Client default | Reconnect after an unexpected disconnect.        |
| `reconnect.baseDelayMs` | `number`      | Client default | Initial reconnect delay.                         |
| `reconnect.maxDelayMs`  | `number`      | Client default | Maximum reconnect delay.                         |
| `logger`                | `PaseoLogger` | Unset          | Debug, info, warning, and error sink.            |

Relay E2EE clients can also pass `e2ee.enabled` and `e2ee.daemonPublicKeyB64`. `appVersion`, `runtimeGeneration`, and runtime-metrics options exist for Paseo client surfaces; ordinary integrations can omit them.

## Client lifecycle

| Method                 | Result            | Behavior                                                                  |
| ---------------------- | ----------------- | ------------------------------------------------------------------------- |
| `connect()`            | `Promise<void>`   | Resolves after the daemon sends its server information.                   |
| `close()`              | `Promise<void>`   | Closes the connection and disposes this client.                           |
| `ensureConnected()`    | `void`            | Throws unless the client is connected.                                    |
| `getConnectionState()` | `ConnectionState` | Returns `idle`, `connecting`, `connected`, `disconnected`, or `disposed`. |

Create a new client after `close()`.

## `client.agents`

| Method               | Result                 | Behavior                                                                                                     |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `list(options?)`     | `PaseoAgentListResult` | Lists a page of agents. `scope`, `filter`, `sort`, `page`, and `subscribe` match the daemon directory query. |
| `create(options)`    | `PaseoAgentHandle`     | Creates an agent and a fresh workspace for `cwd`. Requires `config`.                                         |
| `ref(agentOrId)`     | `PaseoAgentHandle`     | Creates a local handle without fetching.                                                                     |
| `subscribe(handler)` | Unsubscribe function   | Listens for connection-local agent directory updates. Call `list({ subscribe })` first.                      |

Creation options include `config`, `cwd`, `parent`, `title`, `prompt`, `env`, `outputSchema`, `images`, `attachments`, `git`, `worktree`, `autoArchive`, and `labels`.

`config` accepts:

| Field              | Type                      | Meaning                                                                                           |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `provider`         | `string`                  | Required `provider/model` selection.                                                              |
| `modeId`           | `string`                  | Provider operating or permission mode.                                                            |
| `thinkingOptionId` | `string`                  | Provider reasoning level.                                                                         |
| `featureValues`    | `Record<string, unknown>` | Values for features discovered through `providers.listFeatures`.                                  |
| `options`          | JSON object               | Provider-native settings, strictly validated. See [Provider options](/docs/sdk/provider-options). |
| `systemPrompt`     | `string`                  | Additional system or developer instructions.                                                      |
| `mcpServers`       | MCP server map            | Session-scoped MCP servers.                                                                       |
| `toolPolicy`       | MCP tool policy           | Exact preapproval rules for MCP tools.                                                            |

### Agent handle

| Member                      | Result                            | Behavior                                                                                                |
| --------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                        | `string`                          | Stable daemon agent ID.                                                                                 |
| `workspaceId`               | `string \| null`                  | Current workspace placement.                                                                            |
| `cwd`                       | `string \| null`                  | Current working directory.                                                                              |
| `status`                    | Agent status or `null`            | Current lifecycle status.                                                                               |
| `current()`                 | `PaseoAgent \| null`              | Current detailed value observed by this handle; never fetches.                                          |
| `refresh(requestId?)`       | `PaseoAgentRefetchResult \| null` | Fetches the current agent and project placement.                                                        |
| `send(text, options?)`      | `Promise<void>`                   | Resolves when the daemon accepts the prompt.                                                            |
| `run(text, options?)`       | `PaseoAgentRunResult`             | Sends a prompt and waits for that turn. `timeoutMs` controls the wait; it defaults to 10 minutes.       |
| `waitForFinish(timeoutMs?)` | `PaseoAgentRunResult`             | Waits for the active turn, including an initial prompt. Default timeout: 10 minutes.                    |
| `commands(options?)`        | `PaseoAgentCommandsResult`        | Asks the live session for its slash commands and skills, including built-in ones. Options: `requestId`. |
| `subscribe(handler)`        | Unsubscribe function              | Filters agent-directory updates to this ID and refreshes the handle properties.                         |
| `archive()`                 | `{ archivedAt }`                  | Soft-deletes the agent and closes its runtime.                                                          |
| `detach()`                  | `Promise<void>`                   | Removes the parent relationship without stopping the agent.                                             |

`PaseoAgentRunResult` contains `status`, `final`, `error`, and `lastMessage`. `final` refreshes the handle when present.

`PaseoAgentCommandsResult` contains `agentId`, `commands`, and `error`. Each command has `name`, `description`, `argumentHint`, and an optional `kind` of `"command"` or `"skill"`. A provider that cannot answer reports it in `error` rather than rejecting; providers that expose no command list at all return an empty array.

### Timeline handle

`agent.timeline.refetch(options?)` fetches a page. Options are `direction`, `cursor`, `limit`, `projection`, and `requestId`.

`agent.timeline.subscribe(handler)` listens for stream events belonging to the agent and returns a local unsubscribe function.

## `client.workspaces`

| Method                   | Result                        | Behavior                                                                          |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------- |
| `list(options?)`         | `PaseoWorkspaceListResult`    | Lists, filters, pages, or subscribes to the workspace directory.                  |
| `open(cwd)`              | `PaseoWorkspaceHandle`        | Reuses the active workspace for a directory or creates one.                       |
| `create(options)`        | `PaseoWorkspaceHandle`        | Always creates a fresh directory-backed or Paseo-worktree workspace.              |
| `ref(workspaceOrId)`     | `PaseoWorkspaceHandle`        | Creates a local handle.                                                           |
| `archive(workspaceOrId)` | `PaseoWorkspaceArchiveResult` | Archives without first creating a handle.                                         |
| `subscribe(handler)`     | Unsubscribe function          | Listens for connection-local workspace updates. Call `list({ subscribe })` first. |

A workspace handle exposes `id`, `projectId`, `directory`, `name`, `status`, `current()`, `refresh()`, `setTitle(title)`, `archive()`, and `subscribe()`. Pass `null` to `setTitle` to restore the derived workspace name. Use `workspace.agents.create(options)` to create an agent without repeating the workspace ID or directory.

## `client.providers`

| Method                           | Result                        | Behavior                                                                                                                                                 |
| -------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitForReady(options?)`         | `PaseoProviderSnapshotResult` | Waits until no provider is loading. Default timeout: 60 seconds. Rejects with an update-host error when the daemon cannot correlate workspace snapshots. |
| `snapshot(options?)`             | `PaseoProviderSnapshotResult` | Returns the current catalog immediately.                                                                                                                 |
| `refresh(options?)`              | Acknowledgement               | Forces catalog refresh for all or selected providers.                                                                                                    |
| `listAvailable()`                | Availability result           | Reports installed provider availability.                                                                                                                 |
| `listModels(provider, options?)` | Models result                 | Discovers models for one provider and directory.                                                                                                         |
| `listModes(provider, options?)`  | Modes result                  | Discovers permission or operating modes.                                                                                                                 |
| `listFeatures(draftConfig)`      | Features result               | Discovers features for the current draft provider configuration.                                                                                         |
| `diagnostic(provider)`           | Diagnostic result             | Returns human-readable setup diagnostics.                                                                                                                |
| `subscribe(handler)`             | Unsubscribe function          | Listens for catalog updates.                                                                                                                             |

## `client.config`

`config.get(requestId?)` returns the daemon's mutable configuration.

`config.patch(patch, requestId?)` validates, persists, and returns an updated configuration. Use this administrative surface for host configuration, not per-agent choices. A patch affects every client and future agent using that daemon.

## Errors and cleanup

Connection, validation, rejection, and timeout failures reject their promise. Turn outcomes are returned through `PaseoAgentRunResult.status` because permission and provider errors are expected agent states.

Always close the client in `finally`. Closing a client removes its local listeners and network connection; it does not stop agents or archive workspaces.
