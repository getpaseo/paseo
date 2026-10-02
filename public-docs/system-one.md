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

Paseo can also let Jev pick the model and thinking depth for every turn. List supported models and allowed thinking levels per provider in `daemon.systemOne.routing`. A profile-specific entry overrides its provider-family entry:

```json
"systemOne": {
  "enabled": true,
  "routing": {
    "claude": { "models": ["claude-sonnet-5-5", "claude-opus-5-5"], "thinking": ["medium", "high"] },
    "codex": { "models": ["gpt-6.1-sol", "gpt-6-luna"], "thinking": ["medium", "high"] }
  }
}
```

Jev receives the original task and current request, together with eligible profile/model/effort choices. The default model-family priority is Sol, Opus, Sonnet, then Luna. Astra is excluded; automatic Opus xhigh and non-Luna max are excluded. Internal helper agents are not routed. A manual model change after routing keeps that session's selection until recovery needs another available route.

Before selecting an alternative, Paseo checks the same provider-usage snapshot shown in Host Usage. A profile at or above 95% in an unexpired window is excluded. Unknown or failed usage is not proof that an alternative account is available. Actual quota failures keep that account excluded until its reset or a newer available usage snapshot.

Recovery first preserves the current model and effort on another verified available account. If none supports them, Jev reassesses the remaining supported routes. An uncertain task label does not block a confident route. If Jev is disabled, unavailable, or uncertain, recovery selects a verified available default using the model-family priority, preferring high effort and lower account usage. Duplicate configured routes are offered only once. Jev uncertainty alone never makes a free alternative wait for an exhausted account's reset.

When no verified available route remains, the task stays pending until the earliest known reset or a fresh usage/catalog change. Cancel stops that pending task. Capacity errors retry the same model briefly before trying alternatives; quota errors skip those capacity retries. Completed tool checkpoints remain in the session history so recovery does not replay finished writes.

Shadow mode measures whether predicting an agent's next step would pay off before anything acts on a prediction. Set `daemon.systemOne.shadow` to `true`: after every tool call of every provider, Jev predicts the next step (read, search, edit, verify, shell, fetch, subagent, MCP tool, or end of turn), and Paseo scores it against what the agent really did. Nothing is executed. Results go to `$PASEO_HOME/system-one/shadow.jsonl`; `node scripts/shadow-stats.mjs` prints hit and top-2 rates per provider and step, how much of the time the agent's model spent deciding versus running tools, whether predictions were ready in time, the time prefetching could have saved, and an upper bound for model decisions Jev could have made instead (it predicts the kind of step, not its arguments).

To keep a project's code away from TypeSafe entirely, list its directory in `daemon.systemOne.excludedPaths` in `$PASEO_HOME/config.json` (for example `["~/work/company"]`). Agents working below those paths get a refusal from `system_one_decide` and `browser_goal`, and `goal` steps in `browser_test` fail; scripted test steps still run. Paseo reads the list on every decision, so edits apply without a restart.

## Browser goals

The [`browser_goal` tool](/docs/browser) uses the same System One configuration. Paseo enriches Jev with the current URL, an accessibility summary, recent actions, and allowed value slots. Jev chooses the next bounded action; Paseo executes it locally and requires explicit text or URL checks before reporting success.
