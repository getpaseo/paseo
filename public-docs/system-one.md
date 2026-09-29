---
title: System One with Jev
description: Give every Paseo coding agent a fast typed decision primitive for routing, scoring, and bounded judgments.
nav: System One
order: 34
category: Agents
---

# System One with Jev

Paseo can give Claude Code, Codex, OpenCode, Pi, Copilot, and other supported tool clients the same TypeSafe System One capability. Jev complements the agent's main model. It handles small structured judgments; it does not replace the coding agent or execute work itself.

Enable it under **Settings → your host → System One**. Jev uses `https://api.typesafe.ai/v1/systemone` by default. Enter a TypeSafe API key, choose a model such as `jev-latest`, set the confidence threshold, and turn on **Use System One decisions**. The endpoint selector also accepts a compatible self-hosted System One URL.

The key is write-only from the app's point of view. Paseo stores it under the host's private data directory in a file readable only by that user. Daemon configuration responses contain only whether a key is configured and where it came from. Paseo can also use `TYPESAFE_API_KEY` or `~/.config/typesafe-ai/env` as a fallback. Paseo checks a new key with TypeSafe before saving it and refuses one that TypeSafe rejects. If a saved key is rejected later, each request falls through to the next configured key.

## What agents receive

Paseo exposes one shared tool, `system_one_decide`, and a short shared instruction that tells agents to use it before spending substantial reasoning on a bounded judgment.

One call contains:

- `state`: the smallest useful structured facts about the current task.
- `questions`: up to 32 independent Choice, Score, or Noul questions that all use that state.

Both fields are required on every call. `questions` is an object keyed by question name:

```json
{
  "state": { "task": "fix login" },
  "questions": {
    "next": {
      "type": "choice",
      "criteria": { "inspect": "Inspect the failure", "edit": "Edit the code" }
    }
  }
}
```

Agents batch every currently useful question into one request. Jev returns typed answers, probabilities, confidence, model, and latency. The agent then decides whether to act, gather more evidence, or escalate to slower reasoning.

Good uses include routing a task, ranking a short candidate set, checking relevance or risk, classifying an observed UI state, and choosing the next action from a closed set. Deterministic facts, multi-step planning, code execution, and final verification stay with ordinary code and the coding agent.

Never place API keys, passwords, tokens, private keys, or other secrets in the state or questions.

Paseo can also let Jev pick the model and thinking depth for every turn, for any provider. List a ladder per provider in `daemon.systemOne.routing`, cheapest first:

```json
"systemOne": {
  "enabled": true,
  "routing": {
    "claude": { "models": ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5"], "thinking": ["low", "medium", "high", "xhigh"] },
    "codex": { "models": ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"], "thinking": ["low", "medium", "high", "xhigh"] }
  }
}
```

On an agent's first turn Jev picks the cheapest sufficient rung for the task. Later turns only escalate: a short follow-up such as "go on" looks trivial on its own, so routing never steps a running session down, and it leaves a model that is not on the ladder alone. When Jev is unsure, the current setting stays; when Jev is unreachable on the first turn, the turn falls back to the cheapest rung instead of a costly default. A model you pick by hand during a session wins for the rest of that session, and Paseo's internal helper agents are never routed. Routing never blocks a turn.

Agent-spawned subagents (`create_agent` with a caller) are routed before they start: Jev grades the subtask and caps it to the cheapest sufficient rung of the requested provider, so a trivial lookup never spawns an Opus/XHigh child. Human-created agents keep their explicit provider and model. Before routing, Paseo checks the daemon's provider-usage snapshot (the same data behind Host Usage): a provider at or above 95% on any window counts as exhausted. An exhausted provider falls back to its cheapest rung on the first turn and never escalates afterwards; a new subagent moves to the least-used provider with room when one exists. Stale or failed usage data counts as unknown and routes cheap rather than blocking. Running chats never switch providers on their own; they keep their native session and get a switch suggestion instead.

Shadow mode measures whether predicting an agent's next step would pay off before anything acts on a prediction. Set `daemon.systemOne.shadow` to `true`: after every tool call of every provider, Jev predicts the next step (read, search, edit, verify, shell, fetch, subagent, MCP tool, or end of turn), and Paseo scores it against what the agent really did. Nothing is executed. Results go to `$PASEO_HOME/system-one/shadow.jsonl`; `node scripts/shadow-stats.mjs` prints hit and top-2 rates per provider and step, how much of the time the agent's model spent deciding versus running tools, whether predictions were ready in time, the time prefetching could have saved, and an upper bound for model decisions Jev could have made instead (it predicts the kind of step, not its arguments).

To keep a project's code away from TypeSafe entirely, list its directory in `daemon.systemOne.excludedPaths` in `$PASEO_HOME/config.json` (for example `["~/work/company"]`). Agents working below those paths get a refusal from `system_one_decide` and `browser_goal`, and `goal` steps in `browser_test` fail; scripted test steps still run. Paseo reads the list on every decision, so edits apply without a restart.

## Browser goals

The [`browser_goal` tool](/docs/browser) uses the same System One configuration. Paseo enriches Jev with the current URL, an accessibility summary, recent actions, and allowed value slots. Jev chooses the next bounded action; Paseo executes it locally and requires explicit text or URL checks before reporting success.
