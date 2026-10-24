---
title: Hub MCP
description: Connect an MCP client to Hub to run and monitor agents on your enrolled daemons.
nav: MCP
order: 69
category: Hub
---

# Control agents through Hub MCP

Connect your assistant or another MCP client to Hub to start agents on enrolled daemons. Your client can continue its own work while those agents run, then read their status and results. Each worker is an ordinary Paseo agent that you can also open in Paseo.

## Connect your client

Create an organization API key under **API keys** in the Hub dashboard. Select `agents:read` and `agents:control` for discovery and agent control. Add `projects:read` and `runs:dispatch` if the client should also dispatch existing manual workflows.

Configure your client's remote MCP connection with:

| Setting              | Value                                 |
| -------------------- | ------------------------------------- |
| Transport            | Streamable HTTP                       |
| URL                  | `https://your-hub.example/api/v1/mcp` |
| Authorization header | `Bearer <organization-api-key>`       |

Use your own Hub origin. Keep the key in your client's credential storage. Hub authenticates each request, and revoking the key prevents further requests. Organization CLI credentials retain project discovery and manual workflow dispatch; agent control requires an API key with the new scopes selected explicitly. Agent execution completion tokens do not authenticate this endpoint.

The tools available to your client depend on the key's selected scopes. Daemons must be enrolled in that organization and explicitly grant `hub.execute`. That daemon permission covers agents created outside Hub as well as Hub workers. See [Daemon permissions](/docs/hub/daemons).

## Start a worker

1. Call `list_daemons` to choose a connected daemon.
2. Call `list_workspaces` to find a repository root or directory on that daemon. Follow `pageInfo.nextCursor` for additional pages. The response also includes projects with no active workspaces.
3. Call `get_providers` with the daemon ID and working directory. Choose an available provider, model, thinking option, and permission mode from its response.
4. Call `create_agent` with a stable `requestKey`, the daemon ID, working directory, provider, explicit `modeId`, and prompt. Model and thinking selection are optional. Provider options pass through to the daemon unchanged.

For example, use the identifiers returned by discovery:

```json
{
  "daemonId": "<daemon-id>",
  "requestKey": "implement-search-2026-10-10",
  "cwd": "/home/me/project",
  "provider": "codex",
  "model": "<model-id>",
  "thinkingOptionId": "<thinking-option-id>",
  "modeId": "full-access",
  "prompt": "Implement the search feature and report what you changed."
}
```

Select the provider's full-access mode when you want the worker to have full access. Hub requires an explicit permission mode and does not change it for you. The daemon validates provider-native configuration.

By default, `create_agent` creates a separate managed worktree and branch. You can name the branch and base with `workspace: { "kind": "worktree", "newBranch": "feature/search", "base": "main" }`. To share an existing workspace, pass `workspace: { "kind": "reuse", "workspaceId": "<workspace-id>" }`. For a directory without worktree creation, use `workspace: { "kind": "directory" }`.

Creation returns the daemon, agent, and workspace IDs without waiting for the task to finish. You can create multiple workers in parallel. If the response is lost, retry with the same `requestKey` and identical arguments. Give each distinct task a new key.

## Follow progress and results

Use `get_agent` for the agent's current status, active turn, permission requests, and last error. An idle agent has ended its turn; that status does not prove the requested task succeeded.

Use `get_agent_activity` for a bounded page of its saved timeline. It includes assistant messages and tool activity. Start with the default tail page. To poll for subsequent activity, pass `direction: "after"` and the previous `endCursor`. Drain additional pages while `hasNewer` is true. If the daemon reports `reset`, `staleCursor`, or `gap`, fetch a new tail page and read the current status again.

Agent state and timeline live on the daemon. You can reconnect the MCP client or switch clients and continue using the same IDs. The first version uses polling and does not send completion notifications or start a new turn in your main assistant. Scheduling those polls is your client's responsibility.

## Continue, interrupt, and clean up

| Tool                 | Effect                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| `list_agents`        | Discover existing agents, including workers created outside MCP.                    |
| `send_agent_message` | Start another turn or steer a busy agent. Supply a stable `messageKey` for retries. |
| `interrupt_agent`    | Stop the current turn and keep the session reusable.                                |
| `archive_agent`      | Archive one agent session and retain its workspace.                                 |
| `archive_workspace`  | Archive a workspace and its agents, with daemon-managed worktree cleanup.           |

Messages default to `activeTurnBehavior: "steer"`. A provider that cannot steer may interrupt instead. Select `"interrupt"` explicitly when you want that behavior. There is no queue-until-idle option.

Hub keeps sessions and worktrees after a worker finishes. Preserve its changes before calling `archive_workspace`: the daemon may force-remove the managed worktree, including dirty and untracked files. The Git branch remains. Archiving one agent does not remove its worktree.

Interrupting a worker from a Hub workflow does not cancel that workflow. It can remain active until its completion contract or timeout resolves it.

## Dispatch an existing workflow

With `projects:read`, call `list_projects` to find a Hub project. With `runs:dispatch`, call `dispatch_manual_run` with the same arguments as the [manual-run API](/docs/hub/api#manual-run-dispatch). Hub processes it through its existing durable event path. Supply a stable `deliveryKey` for event deduplication and inspect the returned status for dispatch rejections.
