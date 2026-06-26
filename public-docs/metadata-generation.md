---
title: Metadata generation
description: How Paseo uses providers to generate branch names, commit messages, and pull request text, and how to configure them.
nav: Metadata generation
order: 42
category: Configuration
---

# Metadata generation

Paseo asks a language model to write short pieces of text for you so you don't have to. This is separate from the agent you're talking to: it's a small, one-shot call made in the background.

Paseo generates these kinds of metadata:

- **Workspace titles** — a short, task-shaped label for a workspace, shown in the sidebar.
- **Worktree branch names** — a slug for the branch a new worktree agent runs on.
- **Commit messages** — a concise message for the changes you're committing.
- **Pull request title and body** — drafted from the diff when you open a PR.

A workspace title and its branch name are produced together from the same prompt, but you configure their wording independently (see below).

## How a model is chosen

You don't have to configure anything — Paseo picks a model automatically. It builds an ordered list of candidates and tries each one until a generation succeeds, so a slow or unavailable model falls through to the next.

The candidate list is assembled in this order:

1. **Providers you configured**, in the order you list them (see below).
2. **Built-in defaults**, matched against the models of the providers you have enabled:
   1. a `haiku` model
   2. `gpt-5.4-mini` (low reasoning)
   3. `minimax-m2.5`
   4. `nemotron-3-super`
3. **The model currently selected** for that agent or draft, as a last resort.

Each default is a match on the model id or name, so the first enabled provider that ships a matching model wins. Anything that can't be resolved against an enabled provider is skipped. Duplicates are removed, then generation tries the list top to bottom.

The intent of the default order is to prefer small, fast, cheap models for these short tasks before falling back to whatever you have selected.

## Configuring the providers

To control which models Paseo uses — for example to keep all metadata generation on one provider, or to prefer a local model — set `agents.metadataGeneration.providers` in `~/.paseo/config.json`. Your entries are tried before the built-in defaults.

```json
{
  "agents": {
    "metadataGeneration": {
      "providers": [
        { "provider": "claude", "model": "claude-haiku-4-5-20251001", "thinkingOptionId": "low" },
        { "provider": "opencode" }
      ]
    }
  }
}
```

Each entry accepts:

- `provider` (required) — the provider id. Built-in ids are `claude`, `codex`, `copilot`, `opencode`, and `pi`; custom providers use the id you gave them.
- `model` (optional) — a specific model id. Omit it to use that provider's default model.
- `thinkingOptionId` (optional) — a reasoning/thinking level for models that support one. Falls back to the model's default if the value isn't valid for that model.

Restart the daemon after editing the file.

## Per-project instructions

You can steer the wording of each kind of metadata per repository with a `paseo.json` file at your repo root. Paseo reads it from the committed version of the base branch, the same way it reads worktree config.

```json
{
  "metadataGeneration": {
    "title": { "instructions": "Keep titles to a few words, no leading verb." },
    "branchName": { "instructions": "Use the format <type>/<scope>-<short-desc>." },
    "commitMessage": { "instructions": "Follow Conventional Commits." },
    "pullRequest": { "instructions": "Include a Testing section in the body." }
  }
}
```

Each key is optional; only the ones you set are affected. Your instructions **replace** the default style for that metadata type — they are not appended to it — so your wording never competes with Paseo's defaults. The functional requirements (what to produce and the output format) always apply and cannot be overridden.
