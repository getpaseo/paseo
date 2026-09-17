---
title: Common orchestration workflows
description: Prompts for delegating, parallelizing, reviewing, and continuing agent work with Paseo.
nav: Common workflows
order: 31
category: Orchestration
---

# Common orchestration workflows

[Enable Paseo tools](/docs/orchestration#get-started), then ask your main agent for one of these workflows. Adapt the tasks to your project. [Agent profiles](/docs/agent-profiles) let you save settings and describe which agent to use for each kind of work.

## Send work to a different model

Keep planning in your main chat and delegate implementation:

> Use Paseo to check my agent profiles and their notes. Choose one for implementation, create a workspace with worktree isolation, and launch a subagent there to implement the parser change. Have it run the focused tests and report back.

The worker makes the change in its own worktree. If no profile fits, the agent can discover your configured providers and models and tell you what it chose.

## Fan out research

Split independent questions between workers:

> Create three Paseo subagents in this workspace. Have one trace the request path, one inspect the tests, and one look for related regressions. Do not edit files. Synthesize their findings when all three report back.

The workers share your files and appear in the Subagents track. Your main agent collects their findings into one answer.

## Parallelize edits without collisions

Give each independent change its own worktree:

> Split these two issues between two Paseo subagents. Create a separate workspace with worktree isolation from main for each issue. Check my profiles for suitable implementation settings, and have each agent run the focused checks for its change. Summarize both diffs when done.

Each worker edits a separate checkout. You get two changes to inspect, with their check results.

## Implement, then review

Choose different agents for making and judging a change:

> Check my Paseo profiles and their notes for implementation and review. Create a workspace with worktree isolation and launch an implementation worker there. When it finishes, launch an independent reviewer in that workspace to check correctness, missing tests, and unnecessary complexity. Bring the review back here.

The reviewer sees the worker's files in a fresh conversation. Use profiles from different providers when you want another model's judgment.

## Send a prompt to another agent

Agents can prompt each other by **agent ID**, the identifier Paseo uses to address a specific agent. They can communicate across workspaces on the same host, including with agents they did not launch.

1. Right-click the receiving agent's tab and select **Copy agent id**.
2. Paste that ID into your conversation with the sending agent and ask:

> Use Paseo to send this prompt to agent [paste agent ID here]: “Review the parser changes in your workspace and report any missing test cases.”

The receiving agent gets the prompt in its existing conversation. To have it send a separate message back, give it the sender's agent ID too.

Underneath, the agent calls `send_agent_prompt` with the recipient's `agentId` and a `prompt`. Agents can also discover IDs with `list_agents`; the CLI uses [`paseo send <id>`](/docs/cli#sending-messages). For another host, use the [remote CLI workflow](#work-on-another-machine).

## Check, redirect, or continue work

Send these prompts separately as needed:

> Summarize what the subagents are doing and flag anything blocked.

You get a progress summary in the main conversation.

> Tell the parser worker to add the malformed-input case and rerun its test file.

The worker continues in its existing conversation.

> Cancel the UI worker's current turn, but keep the agent so I can redirect it.

The current task stops; the worker remains available for a follow-up.

## Work on another machine

The CLI can target another Paseo host. First [connect it to the remote daemon](/docs/cli#connecting-to-a-remote-daemon) and identify a workspace on that host. The repository and required provider must be available there.

> Use the Paseo CLI with the remote host and workspace I supplied. Launch an agent there to investigate the failing build, inspect its output, and summarize the findings here. Do not change files.

The worker runs on the remote machine. Use the CLI's global `--host` option for that destination; injected Paseo tools operate on the main agent's own host.

## Keep an agent working with a heartbeat

A heartbeat prompts the same agent periodically, preserving its conversation:

> Use Paseo to create a heartbeat every 10 minutes. Continue this migration in small steps, run the focused checks after each step, and delete the heartbeat when the migration is complete. Set it to expire after two hours.

The agent resumes the task on that cadence. For a fresh agent on each run, [create a schedule](/docs/schedules) instead.

## Where the work appears

Open the **Subagents track** near the composer to inspect delegated work.

|              | Paseo subagents                                | Native provider subagents                      |
| ------------ | ---------------------------------------------- | ---------------------------------------------- |
| Provider     | Any configured provider                        | Chosen within the parent provider's own system |
| Workspace    | Current or explicitly selected workspace       | Managed by the provider                        |
| Conversation | Full agent session you can talk to             | Read-only timeline                             |
| Controls     | Follow up, change settings, archive, or detach | Lifecycle managed by the provider              |

A Paseo subagent in another workspace still belongs to its parent's track. It also opens as a tab in its own workspace. To make it a top-level agent, detach it in the app or with [`paseo agent detach`](/docs/cli#agent-modes).

See the [MCP reference](/docs/mcp#mental-model) for workspace and parentage rules.
