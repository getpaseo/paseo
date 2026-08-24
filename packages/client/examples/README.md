# Paseo Client SDK Examples

These examples use only the public SDK root:

```ts
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
```

Each example takes the daemon WebSocket URL as an argument. In worktree dev, read it
from the portless banner or `portless get daemon`; for the desktop-managed daemon,
use the URL for that daemon.

- `quickstart.ts` runs one agent and prints its reply. It is a standalone script with the URL at the top; the rest export functions.
- `workspaces.ts` covers creating a fresh workspace, opening by directory, refreshing, and archiving.
- `agents-and-providers.ts` covers provider discovery, creating agents, and waiting for turns.
- `events-and-timeline.ts` covers subscribing to workspace, agent, and timeline events, plus refetching a timeline page.
- `issue-to-agent.ts` turns an issue record into a visible Paseo workspace and agent.
- `parallel-review.ts` launches several reviewers concurrently and cleans them up.
- `provider-settings.ts` covers provider settings that are currently daemon config-backed.

Provider profiles, provider env vars, custom binaries, and additional models are still raw daemon config behavior. The SDK exposes them through `client.config.get()` and `client.config.patch()` until first-class provider settings RPCs exist.
