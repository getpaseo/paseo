---
title: Oh My Pi
description: Install and turn on Oh My Pi for Paseo.
nav: Oh My Pi
order: 30
category: Providers
---

# Oh My Pi

Run Oh My Pi (OMP) in Paseo with your existing `omp` installation and settings.

## Getting started

1. Install [Oh My Pi](https://github.com/can1357/oh-my-pi) on your daemon host and make sure that `omp` runs in a terminal.
2. In Paseo, open **Settings → Hosts → your host → Providers** and turn on **Oh My Pi**.

Oh My Pi is off by default. You can also turn it on in `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "omp": { "enabled": true }
    }
  }
}
```

If `omp` is outside your daemon's PATH, use a [command override](/docs/custom-providers). To run a second OMP profile with its own settings, see [OMP profiles](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md#omp-profiles-and-pi-compatible-forks) on GitHub.

## Permission modes

**Full Access** is the default mode.

| Mode           | Effect                                                   |
| -------------- | -------------------------------------------------------- |
| Full Access    | Tools run without prompts.                               |
| Write Approval | Reads run without prompts. Writes require approval.      |
| Always Ask     | Tools that write files or run commands require approval. |

## Tools, subagents, and sessions

- Oh My Pi agents can use Paseo's tools, such as the tools that create and message other agents.
- Subagents that Oh My Pi starts appear as subagents in Paseo.
- Paseo can import sessions that you started in a terminal. It reads them from `~/.omp/agent/sessions`.
