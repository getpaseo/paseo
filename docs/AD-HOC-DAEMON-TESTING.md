# Ad-hoc daemon testing

Spin up an isolated daemon programmatically without touching the main daemon on port 6767.

## Quick start

```typescript
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { createPaseoDaemon } from "./bootstrap.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const logger = pino({ level: "warn" });
const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-test-"));
const paseoHome = path.join(paseoHomeRoot, ".paseo");
await mkdir(paseoHome, { recursive: true });
const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));

const daemon = await createPaseoDaemon(
  {
    listen: "127.0.0.1:0", // OS picks a free port
    paseoHome,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: false,
    staticDir,
    mcpDebug: false,
    agentClients: {},
    agentStoragePath: path.join(paseoHome, "agents"),
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    appBaseUrl: "https://app.paseo.sh",
    // Add custom config here, e.g.:
    // providerOverrides: { ... },
  },
  logger,
);

await daemon.start();
const target = daemon.getListenTarget();
const port = target!.type === "tcp" ? target!.port : null;

const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  appVersion: "0.1.54", // see gotcha #1
});
await client.connect();
await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

// ... do your testing ...

await client.close();
await daemon.stop();
await rm(paseoHomeRoot, { recursive: true, force: true });
await rm(staticDir, { recursive: true, force: true });
```

Run with:
```bash
npx tsx packages/server/src/server/your-script.ts
```

## Using the test helper

For simpler cases, `createTestPaseoDaemon` + `DaemonClient` handles temp dirs and port selection:

```typescript
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const daemon = await createTestPaseoDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.1.54",
});
await client.connect();
await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

// ... test ...

await client.close();
await daemon.close(); // stops daemon + cleans up temp dirs
```

The test helper does **not** expose `providerOverrides`. Use `createPaseoDaemon` directly when you need it (see quick start above).

## Common client methods

```typescript
// Provider discovery
const snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
const models = await client.listProviderModels("claude");
const modes = await client.listProviderModes("claude");

// Agent lifecycle
const agent = await client.createAgent({ provider: "claude", cwd: "/tmp" });
await client.sendMessage(agent.id, "Hello");
const updated = await client.waitForAgentUpsert(agent.id, (s) => s.status === "idle");
```

## Gotchas

### 1. appVersion gates provider visibility

The daemon hides non-legacy providers (anything other than claude, codex, opencode) from clients that don't send an `appVersion >= 0.1.45`. The `DaemonClient` sends no version by default, so custom providers like ACP-based ones will be invisible in snapshot responses.

Always pass `appVersion`:
```typescript
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  appVersion: "0.1.54",
});
```

### 2. Provider snapshots are async

After the daemon starts, providers are probed in the background. The first `getProvidersSnapshot()` call will likely return `status: "loading"` for most providers. Poll until the provider you care about is no longer loading:

```typescript
let snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
for (let i = 0; i < 20; i++) {
  const entry = snapshot.entries.find((e) => e.provider === "gemini");
  if (entry && entry.status !== "loading") break;
  await new Promise((r) => setTimeout(r, 2_000));
  snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
}
```

### 3. fetchAgents is required before most operations

Call `client.fetchAgents()` after connecting. The daemon session expects this handshake before it processes other requests — without it, messages like `get_providers_snapshot_request` will silently hang.

### 4. listen: "127.0.0.1:0" for port allocation

Always use port `0` so the OS picks a free port. Never hardcode a port — it will collide with the main daemon or other test runs.

### 5. Script must live inside packages/server

The test utilities use relative imports through the TypeScript project. Place your script somewhere under `packages/server/src/` and import from there. Scripts outside the repo will fail with module resolution errors.

### 6. Cleanup on failure

Wrap your test logic in try/finally to ensure the daemon stops and temp dirs are cleaned up, even if an assertion fails:

```typescript
try {
  // ... test logic ...
} finally {
  await client.close();
  await daemon.stop().catch(() => undefined);
  await rm(paseoHomeRoot, { recursive: true, force: true });
}
```

### 7. ACP providers spawn real processes

When testing ACP providers (e.g., Gemini with `extends: "acp"`), the daemon will spawn real processes to probe for models and modes. The binary must be installed and on PATH. Probing can take 5-15 seconds depending on the provider.
