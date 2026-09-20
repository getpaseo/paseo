---
title: Always-on daemon
description: Run one shared Paseo daemon and connect every phone, laptop, and CLI to the same agents and tabs.
nav: Always-on daemon
order: 5
category: Getting started
---

# Always-on daemon

Paseo state belongs to a daemon. Clients connected to the same daemon see the same workspaces and
agents; connecting two devices to different daemons creates two independent sets. For tabs that
remain available while a laptop sleeps, run one daemon on an always-on machine and make it the
default target everywhere.

The relay is the recommended connection path. It works from a phone or another computer without
opening an inbound port, and the connection is end-to-end encrypted.

## Pair every client with one daemon

On the always-on host, print its pairing link:

```bash
paseo daemon pair --json
```

Keep the link private. It is the connection credential for that daemon.

In the mobile app, add a host and scan the QR code or paste the `url` from that command. Repeat in
other graphical clients that should share the same agents.

On every computer where you use the CLI, persist that same link as the default target:

```bash
paseo target set 'https://app.paseo.sh/#offer=...'
paseo target show
paseo ls -a -g
```

The target is stored in `$PASEO_HOME/cli.json` with owner-only permissions. `--host` and
`PASEO_HOST` still override it for one command or shell. To return to local daemon discovery:

```bash
paseo target clear
```

## Open a tab from any CLI

Paths and workspaces are resolved on the daemon host, not on the computer running the CLI. List the
shared daemon's workspaces, then launch into one of them:

```bash
paseo workspace ls --json
paseo run --workspace <workspace-id> --background "investigate the failing build"
```

`paseo run` creates a normal, durable agent and marks it to auto-open as a tab. Connected clients,
including mobile, receive the daemon update live. A client that connects later also opens the tab
from the daemon snapshot.

For a directory that is not registered yet, pass the path as it exists on the always-on host:

```bash
paseo run --cwd /srv/code/project --background "review the current changes"
```

## Tailnet alternative

You can persist a direct target instead of a relay offer:

```bash
paseo target set 'm4-mini:6767'
```

The daemon must listen on its tailnet address, and the phone must add that same address as a direct
connection. Configure password authentication before exposing a daemon on any network interface.
See [Security](/docs/security#direct-connections) for the direct-connection checklist.

## Operational rule

Do not run a second daemon and expect its agents to synchronize. Paseo synchronizes connected
clients around one authoritative daemon; it does not replicate agent state between daemons. Back up
that host's `$PASEO_HOME` and keep the host awake using the operating system's normal service
manager.
