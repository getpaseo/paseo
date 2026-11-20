---
title: Pi
description: Install Pi and run it in Paseo.
nav: Pi
order: 32
category: Providers
---

# Pi

Run Pi in Paseo with your existing `pi` installation, credentials, and settings.

## Getting started

1. Install [Pi](https://pi.dev) on your daemon host.
2. Connect Pi to a model provider, and make sure that `pi` runs in a terminal.
3. In Paseo, choose **Pi** when you start an agent.

Pi appears in Paseo when the daemon can launch `pi`. If `pi` is outside your daemon's PATH, use a [command override](/docs/custom-providers#custom-binary).

## Modes and sessions

- Pi has no permission modes, so Paseo shows no mode selector for a Pi agent.
- Paseo can import sessions that you started in a terminal. It reads them from `~/.pi/agent/sessions`, or from the session directory that you configured in Pi.

## Timeouts

Paseo waits 60 seconds for Pi to answer a control request, such as a request for the model list. If Pi needs longer on your host, raise `rpcTimeoutMs` in [Provider options](/docs/custom-providers#provider-options).

## See also

- [Oh My Pi](/docs/supported-providers/omp), a separate provider with its own permission modes.
- [Pi-compatible forks](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md#omp-profiles-and-pi-compatible-forks) on GitHub, for a provider that keeps Pi's RPC mode under another command.
