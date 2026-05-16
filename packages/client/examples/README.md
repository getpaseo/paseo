# Paseo Client SDK Examples

These examples use only the public SDK root:

```ts
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
```

Pass the daemon WebSocket URL into the exported functions. In worktree dev, read it
from the portless banner or `portless get daemon`; for the desktop-managed daemon,
use the URL for that daemon.

- `workspaces.ts` covers creating, opening, refetching, and archiving a workspace.
- `agents-and-providers.ts` covers creating agents and choosing providers with `client.providers.*`.
- `events-and-timeline.ts` covers subscribing to workspace, agent, and timeline events, plus refetching a timeline page.
- `provider-settings.ts` covers provider settings that are currently daemon config-backed.

Provider profiles, provider env vars, custom binaries, and additional models are still raw daemon config behavior. The SDK exposes them through `client.config.get()` and `client.config.patch()` until first-class provider settings RPCs exist.
