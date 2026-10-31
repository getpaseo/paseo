# ZCode Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled Paseo plugin that drives ZCode over its existing `zcode app-server --stdio` protocol, so Paseo can open a ZCode session, stream replies, render tool calls, answer permissions, switch model and mode, and list and restore sessions — with the ZCode repository unmodified.

**Architecture:** The plugin owns its transport, session state, catalog and capabilities, following the `plugins/antigravity-provider/` pattern. ZCode's two protocol generations sit behind one `ZCodeTransport` interface; the legacy implementation lands first, and the V4 implementation follows in a separate plan. The provider never sends a prompt until a pending cancellation has settled, and it never lets a late stop reach the wrong turn.

**Tech Stack:** TypeScript, Zod, `@getpaseo/plugin/server` (`spawnProcess`, `execCommand`, `terminateProcess`), `@getpaseo/plugin/server/provider` (`ProviderRegistration`, `ProviderInput`, `ProviderEvent`), Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-10-30-zcode-provider-design.md`

## Global Constraints

These apply to every task. Copy them into the task brief you hand an implementer.

- The ZCode repository at `/Users/huazhongmin/IdeaProjects/ZCode` is read-only for this work. Nothing in this plan edits it.
- The provider ships as a bundled plugin under `plugins/zcode-provider/`. Paseo core gains no provider manifest entry, no provider factory, and no protocol-layer provider id.
- Provider protocol version stays `1`. `PROVIDER_PROTOCOL_VERSION` in `packages/plugin/src/server/provider.ts` is not changed.
- `paseo-plugin.json` reads exactly `{ "id": "zcode-provider", "requirements": { "paseo": ">=0.14.1-beta.1" } }`. The floor is the release that carries the Task 1 launch-resolution fix. `v0.14.0-beta.2` and `v0.14.0` are already published and both predate that fix, so a floor of `>=0.14.0-beta.2` would admit a daemon that ignores `resolveCommand` entirely and can never find the binary. The floor is load-bearing: `assertPluginCompatibility` runs inside `compileDirectoryPlugin`, which every start path goes through — `PluginService.start` for configured plugins and `PluginService.startBuiltinPlugin` for bundled ones — so an incompatible daemon refuses the plugin with a readable message instead of failing later on a strict metadata schema. Task 1 lands before the plugin work starts; confirm the floor against the release that actually carries it before the plugin ships. The branch has to sit on that release line: `scripts/builtin-plugins-dist.test.mjs` loads every listed built-in plugin with the server's own version, so a checkout whose `package.json` version is below the floor fails that test. The branch therefore carries `0.14.1-beta.1`, which the floor admits, while `0.14.0` and `0.14.0-beta.2` are rejected.
- The legacy transport declares exactly these capabilities: `prompt.message`, `permission`, `permission.tool_policy`, `session.configure`, `session.list`, `session.persistence`, `session.archive`, `session.unarchive`, `session.can_stop_runtime`, `session.subsession`, `timeline.plugin`. It does not declare `session.revert.conversation`, `session.revert.files`, `session.revert.both`, `prompt.steer`, or `prompt.output_schema`.
- The legacy transport does not declare `prompt.command` or `prompt.image` yet, even though the design's capability matrix lists both for the legacy transport. A declared capability is a promise the daemon trusts: the daemon routes a command or image prompt to the provider and rejects it only if the capability is absent. Declaring one the transport cannot honour turns a clean rejection into a runtime failure, and dropping an image silently loses the user's content. The legacy transport's `send` carries text only, and the plan has no grounded description of the ZCode attachment or slash-command wire format. Slash commands come from `available_commands_update` and land with the parity work the design schedules as P2. Both capabilities return with that work; until then the session rejects a command or a non-text part outright rather than pretending to handle it.
- Binary resolution order, first match wins: the user's `agents.providers.zcode.command` override, then `zcode` on PATH, then the runtime bundled in the ZCode desktop app under `resources/glm/`, then the `GLM_BINARY_PATH` environment variable.
- When the bundled JavaScript runtime is used, the child process runs as `{ command: process.execPath, args: [bundlePath, "app-server", "--stdio"], env: { ELECTRON_RUN_AS_NODE: "1" } }`. The `resolveCommand` hook carries no environment: it returns the command and its arguments only. The plugin merges `ELECTRON_RUN_AS_NODE` at its own spawn site, keyed off the launch it was actually handed, because a user override can replace the command the hook resolved.
- ZCode frames are `{ id, method, params? }` for requests, `{ id, result }` for responses, `{ id, error: { code, message, data? } }` for failures, and `{ eventId, sessionId, turnId?, seq, timestamp, type, payload? }` for events.
- Every frame decoder is tolerant. Unknown fields are dropped, unknown event types are ignored, and a structurally broken frame is counted in the diagnostic rather than ending the connection.
- ZCode delivers legacy events by cursor, not by push. Each session polls `session/events` with an `afterSeq` cursor.
- ZCode asks the host for permission with a reverse request, `interaction/requestPermission`, and waits for that request's answer. The host answers requests as well as making them, and there is no `interaction/respond` method to call instead.
- ZCode owns its own authentication. No test carries an auth check, an environment gate, or a conditional skip.
- Tests use the two categories in `docs/testing.md` and nothing else: unit tests with injected ports, and real end-to-end tests. No `vi.mock`, no JSDOM, no component mounting.
- Use the npm scripts for tooling. `npm run lint`, `npm run format:files -- <paths>`, `npm run typecheck`. Never call `oxlint`, `oxfmt` or `eslint` directly.
- Run only the test file you changed: `npx vitest run <file> --bail=1`. Never run a workspace-wide suite.
- The stop boundary in Task 7 is a hard requirement, not a refinement. A cancel that never settled must block new runs.

## Review Focus

Five input classes the spec implies that no task's happy path exercises. Each one has a test in the task that owns the code.

1. **A ZCode event carrying a field the provider does not know.** ZCode's schemas are strict and keep gaining fields, and one dropped field must not drop a whole turn. Expected: the event still reaches the timeline. Tested in Task 3.
2. **Stop pressed twice.** The second press must retry the cancel that is already in flight, not open a second one that kills the next turn. Expected: exactly one cancellation reaches ZCode. Tested in Task 7.
3. **A prompt sent while a cancel is still settling.** Expected: refused, with the refusal reported, and the run does not start. Tested in Task 7.
4. **The ZCode binary missing.** Expected: the provider is unavailable with a diagnostic naming all four resolution paths, and the daemon does not crash. Tested in Task 2.
5. **A permission option whose answer carries `permissionUpdates`.** Expected: the rule change reaches ZCode intact, so "always allow" survives the round trip. Tested in Task 8.

---

### Task 1: Core — launch resolution honors a user override and a plugin-supplied command

The plugin needs to own binary discovery, and the daemon needs to keep owning the environment. Today neither is possible: `resolveLaunch` returns `undefined` before it reads the user's override, and it throws before the plugin's `status` can run.

**The plugin's `ProviderRegistration` object lives in the plugin's child process.** The daemon never holds it. `packages/server/src/server/plugins/index.ts` rebuilds a proxy registration from the metadata the plugin sent, and every callback on that proxy is a message across the plugin IPC bridge. A new provider callback is therefore a bridge change, not just a type change: the SDK type, the process protocol, the plugin-side handler, the daemon-side request, and the proxy all move together. A hook that only exists in the SDK type is inert.

**Files:**

- Modify: `packages/plugin/src/server/provider.ts:29-43` — add the `resolveCommand` hook to `ProviderRegistration`
- Modify: `packages/server/src/server/plugins/plugin-process-protocol.ts:17-26` — advertise the hook in the provider metadata
- Modify: `packages/server/src/server/plugins/plugin-process-protocol.ts:34-78` — add the `provider.resolve_command` request
- Modify: `packages/server/src/server/plugins/plugin-process-protocol.ts:114-125` — validate the new metadata field
- Modify: `packages/server/src/server/plugins/plugin-process-protocol.ts:145-264` — validate the new request
- Modify: `packages/server/src/server/plugins/plugin-process.ts:117-141` — validate the callback at registration
- Modify: `packages/server/src/server/plugins/plugin-process.ts:158-168` — advertise the callback in the metadata
- Modify: `packages/server/src/server/plugins/plugin-process.ts:363-378` — reject the request while the plugin is stopping
- Modify: `packages/server/src/server/plugins/plugin-process.ts:466-495` — answer the request
- Modify: `packages/server/src/server/plugins/runtime.ts:419-436` — the daemon-side request
- Modify: `packages/server/src/server/plugins/index.ts:40-67` — the runtime port gains the request
- Modify: `packages/server/src/server/plugins/index.ts:688-706` — the proxy gains the callback
- Modify: `packages/server/src/server/agent/plugin-provider.ts:157-170` — one launch resolution order
- Test: `packages/server/src/server/agent/plugin-provider.test.ts`
- Test: `packages/server/src/server/plugins/index.posix.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `ProviderRegistration.resolveCommand?(): Promise<readonly [string, ...string[]] | undefined>` (SDK type, published in `@getpaseo/plugin`).
  - `PluginRuntime.resolveProviderCommand(pluginId, providerId): Promise<readonly [string, ...string[]] | undefined>` (daemon side).
  - A `resolveLaunch` that returns a complete `ProviderLaunch` whenever a command was resolved by any of the three sources.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/server/agent/plugin-provider.test.ts`. Add `writeFile` and `chmod` to the `node:fs/promises` import.

```ts
describe("plugin launch resolution", () => {
  const logger = createTestLogger();
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /**
   * The launch path is resolved on disk, so a command that does not exist
   * fails before the provider reports anything. Every path here is a real
   * executable.
   */
  async function executable(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paseo-launch-"));
    dirs.push(dir);
    const file = join(dir, name);
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
    return file;
  }

  function probeRegistration(
    resolveCommand: () => Promise<readonly [string, ...string[]] | undefined>,
    launches: (ProviderLaunch | undefined)[],
  ): ProviderRegistration {
    return {
      id: "launch-resolution-probe",
      label: "Launch Resolution Probe",
      async resolveCommand() {
        return resolveCommand();
      },
      async status({ launch }) {
        launches.push(launch);
        return { available: true, diagnostic: launch?.command ?? "no-launch" };
      },
      async connect() {
        throw new Error("not used");
      },
    };
  }

  function clientFor(
    registration: ProviderRegistration,
    options?: {
      command?: string[];
      appendArgs?: string[];
    },
  ): AgentClient {
    const plugins = new PluginAgentClientRegistry(logger);
    plugins.replace([registration]);
    const registry = buildProviderRegistry(logger, {
      pluginProviders: plugins.definitions(),
      ...(options?.command
        ? {
            providerOverrides: {
              "launch-resolution-probe": { command: options.command },
            },
          }
        : {}),
      ...(options?.appendArgs
        ? {
            runtimeSettings: {
              "launch-resolution-probe": {
                command: { mode: "append", args: options.appendArgs },
              },
            },
          }
        : {}),
    });
    return registry["launch-resolution-probe" as AgentClient["provider"]].createClient(logger);
  }

  test("a user command override wins over the plugin's own resolution", async () => {
    const launches: (ProviderLaunch | undefined)[] = [];
    const pluginCommand = await executable("plugin-zcode");
    const userCommand = await executable("user-zcode");
    const client = clientFor(
      probeRegistration(async () => [pluginCommand], launches),
      { command: [userCommand] },
    );
    await expect(client.isAvailable()).resolves.toBe(true);
    // Assert which command was resolved. isAvailable() returning true passes
    // whether or not the override won.
    expect(launches.at(-1)?.command).toBe(userCommand);
  });

  test("the plugin's own resolution supplies the command when the user set none", async () => {
    const launches: (ProviderLaunch | undefined)[] = [];
    const pluginCommand = await executable("plugin-zcode");
    const client = clientFor(probeRegistration(async () => [pluginCommand], launches));
    await expect(client.isAvailable()).resolves.toBe(true);
    expect(launches.at(-1)?.command).toBe(pluginCommand);
  });

  test("an append override keeps the plugin's own command", async () => {
    const launches: (ProviderLaunch | undefined)[] = [];
    const pluginCommand = await executable("plugin-zcode");
    const client = clientFor(
      probeRegistration(async () => [pluginCommand], launches),
      {
        appendArgs: ["--extra"],
      },
    );
    await expect(client.isAvailable()).resolves.toBe(true);
    expect(launches.at(-1)?.command).toBe(pluginCommand);
  });

  test("a missing user override target fails hard", async () => {
    const launches: (ProviderLaunch | undefined)[] = [];
    const pluginCommand = await executable("plugin-zcode");
    const client = clientFor(
      probeRegistration(async () => [pluginCommand], launches),
      {
        command: [join(dirname(pluginCommand), "definitely-missing-zcode")],
      },
    );
    await expect(client.isAvailable()).resolves.toBe(false);
  });
});
```

`providerOverrides.<id>.command` is the user-facing setting and is a string array; the registry turns it into a `replace` command. `runtimeSettings.<id>.command` carries the `append` mode. The two are different sources, and a test that uses the wrong one proves nothing.

Append to `packages/server/src/server/plugins/index.posix.test.ts`. This is the test that proves the hook survives the trip through the plugin process. A test that only exercises an in-process registration object proves nothing about the bridge.

```ts
it("carries a provider's resolved command across the plugin process", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
  roots.push(home);
  const directory = await createPlugin(
    "provider-resolve-command",
    `export default function contribute(server) {
      server.registerProvider({ id: "plugin-agent", label: "Plugin agent",
        async resolveCommand() { return ["/plugin/owned/zcode", "app-server", "--stdio"]; },
        async connect() { throw new Error("not opened by this test"); },
      });
      return () => {};
    }`,
  );
  const service = createService(home);
  await service.start();
  try {
    if (service.installDirectory) await service.installDirectory({ path: directory });
    const [registration] = service.getProviderRegistrations();
    expect(registration).toMatchObject({ id: "plugin-agent" });
    await expect(registration!.resolveCommand!()).resolves.toEqual([
      "/plugin/owned/zcode",
      "app-server",
      "--stdio",
    ]);
  } finally {
    await service.stopAllPlugins();
  }
});
```

Match the surrounding test in `index.posix.test.ts` for how it creates a service and installs a plugin directory. The other tests in that file use `createService(home)` plus `await service.installDirectory({ path: directory })`, and some use `new PluginService(...)` with `BuiltinPluginLoader`. Use whichever the neighbouring tests use so the test runs in the same environment.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server/src/server/agent/plugin-provider.test.ts packages/server/src/server/plugins/index.posix.test.ts --bail=1`

Expected: FAIL. The `resolveCommand` property does not exist on `ProviderRegistration`, so the test file fails to typecheck, and the bridge test finds no `resolveCommand` on the published registration.

- [ ] **Step 3: Add the hook to the SDK type**

In `packages/plugin/src/server/provider.ts`, extend `ProviderRegistration`:

```ts
export interface ProviderRegistration {
  /** Activate only while agents.providers contains this provider ID, independently of enabled. */
  requiresConfiguration?: boolean;
  /** Equal keys share discovery within this provider. Include effective configuration and execution environment. */
  getCatalogCacheKey?(options: ProviderCatalogOptions): Promise<string | undefined>;
  /** Default executable and arguments; the daemon resolves overrides before status/connect. */
  command?: readonly [string, ...string[]];
  /**
   * Resolve the default executable when the plugin owns binary discovery.
   * A user override in agents.providers.<id>.command still wins over this.
   * Return undefined when nothing was found; the plugin's status reports why.
   */
  resolveCommand?(): Promise<readonly [string, ...string[]] | undefined>;
  status?(request: ProviderStatusRequest): Promise<ProviderStatus>;
  id: string;
  label: string;
  description?: string;
  /** Plugin-directory-relative path to a self-contained SVG file. */
  icon?: string;
  connect(request: ProviderConnectRequest): Promise<ProviderConnection>;
}
```

- [ ] **Step 4: Extend the plugin process protocol**

In `packages/server/src/server/plugins/plugin-process-protocol.ts`:

Add to `PluginProviderMetadata`:

```ts
  hasResolveCommand?: boolean;
```

Add to `providerMetadataSchema`:

```ts
    hasResolveCommand: z.boolean().optional(),
```

Add to `PluginProcessRequest`:

```ts
  | {
      type: "provider.resolve_command";
      requestId: string;
      providerId: string;
    }
```

Add to `PluginProcessRequestSchema`:

```ts
    z
      .object({
        type: z.literal("provider.resolve_command"),
        requestId: z.string().min(1),
        providerId: z.string().min(1),
      })
      .strict(),
```

- [ ] **Step 5: Answer the request in the plugin process**

In `packages/server/src/server/plugins/plugin-process.ts`:

Validate the callback in `registerProvider`, next to the existing `getCatalogCacheKey` and `status` checks:

```ts
if (provider.resolveCommand !== undefined && typeof provider.resolveCommand !== "function")
  throw new Error(`Invalid command resolution callback for plugin provider ${id}`);
```

Advertise it in `providerMetadata`:

```ts
      hasResolveCommand: provider.resolveCommand !== undefined,
```

Add `provider.resolve_command` to the request types `rejectWhileStopping` rejects:

```ts
      message.type === "provider.resolve_command" ||
```

Handle the request, next to the `provider.status` and `provider.catalog_key` handlers:

```ts
if (message.type === "provider.resolve_command") {
  void (async () => {
    const provider = providers.get(message.providerId);
    if (!provider) throw new Error(`Unknown provider: ${message.providerId}`);
    if (!provider.resolveCommand)
      throw new Error(`Provider cannot resolve a command: ${message.providerId}`);
    const output = await provider.resolveCommand();
    if (output !== undefined && !isResolvedCommand(output))
      throw new Error("Invalid resolved command");
    send({ type: "result", requestId: message.requestId, output });
  })().catch((error) =>
    send({ type: "error", requestId: message.requestId, error: describeError(error) }),
  );
  return;
}
```

Add the validator next to the other module-level helpers:

```ts
function isResolvedCommand(value: unknown): value is readonly [string, ...string[]] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string" && part.trim().length > 0)
  );
}
```

- [ ] **Step 6: Add the daemon-side request**

In `packages/server/src/server/plugins/runtime.ts`, next to `getProviderStatus`:

```ts
  async resolveProviderCommand(
    pluginId: string,
    providerId: string,
  ): Promise<readonly [string, ...string[]] | undefined> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    const output = await this.request(loaded, {
      type: "provider.resolve_command",
      requestId: randomUUID(),
      providerId,
    });
    return isResolvedCommand(output) ? output : undefined;
  }
```

Export `isResolvedCommand` from `plugin-process-protocol.ts` so both sides share one definition, and import it in `runtime.ts`.

- [ ] **Step 7: Rebuild the proxy registration**

In `packages/server/src/server/plugins/index.ts`, add to `PluginRuntimePort`:

```ts
  resolveProviderCommand?: PluginRuntime["resolveProviderCommand"];
```

Add to the registration the proxy builds:

```ts
          resolveCommand: provider.hasResolveCommand
            ? () => {
                if (!this.runtime.resolveProviderCommand)
                  throw new Error("Plugin runtime cannot resolve provider commands");
                return this.runtime.resolveProviderCommand(pluginId, provider.id);
              }
            : undefined,
```

- [ ] **Step 8: Rewrite launch resolution**

In `packages/server/src/server/agent/plugin-provider.ts`, replace the body of `resolveLaunch` so it reads:

```ts
  private async resolveLaunch(): Promise<ProviderLaunch | undefined> {
    const env = createProviderEnv({ runtimeSettings: this.runtimeSettings });
    const override = this.runtimeSettings?.command;
    if (override?.mode === "replace") {
      const launch = await resolveProviderLaunch({ commandConfig: override });
      launch.env = env;
      const availability = await checkProviderLaunchAvailable(launch);
      if (!availability.resolvedPath)
        throw new Error(`${launch.command} not found on PATH`);
      return { command: resolvePath(availability.resolvedPath), args: launch.args, env };
    }
    const command = this.registration.command ?? (await this.registration.resolveCommand?.());
    if (!command) return undefined;
    const launch = await resolveProviderLaunch({
      commandConfig: override,
      defaultBinary: command[0],
    });
    if (launch.source !== "override") launch.args.unshift(...command.slice(1));
    launch.env = env;
    const availability = await checkProviderLaunchAvailable(launch);
    if (!availability.resolvedPath) throw new Error(`${launch.command} not found on PATH`);
    return { command: resolvePath(availability.resolvedPath), args: launch.args, env };
  }
```

`ProviderCommand` has three modes. Only `replace` replaces the command, so only `replace` short-circuits the plugin's own resolution. `default` and `append` keep the plugin's command and add the override's arguments to it. `resolveProviderLaunch` throws when `defaultBinary` is undefined and the mode is not `replace`, so the `replace` branch is the only one that may omit `defaultBinary`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run packages/server/src/server/agent/plugin-provider.test.ts packages/server/src/server/plugins/index.posix.test.ts --bail=1`

Expected: PASS.

- [ ] **Step 10: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add packages/plugin/src/server/provider.ts packages/server/src/server/plugins/plugin-process-protocol.ts packages/server/src/server/plugins/plugin-process.ts packages/server/src/server/plugins/runtime.ts packages/server/src/server/plugins/index.ts packages/server/src/server/agent/plugin-provider.ts packages/server/src/server/agent/plugin-provider.test.ts packages/server/src/server/plugins/index.posix.test.ts
git commit -m "feat(plugins): let a plugin resolve its own default executable

A plugin that owns binary discovery could not use it. Launch resolution
returned early when the plugin declared no command, so the user's
agents.providers.<id>.command override was never read, and it threw on a
missing default binary before the plugin's status callback could run.

Add an optional resolveCommand hook and carry it across the plugin
process boundary, then follow one resolution order: a replace override
wins, then the plugin's declared command, then the plugin's own
resolution. The daemon-owned environment reaches the launch in every
case."
```

This commit is its own pull request. It merges before the plugin work starts, so no later commit carries a core diff.

---

### Task 2: Plugin skeleton, binary discovery, and registration

**Files:**

- Create: `plugins/zcode-provider/paseo-plugin.json`
- Create: `plugins/zcode-provider/index.server.ts`
- Create: `plugins/zcode-provider/icon.svg`
- Create: `plugins/zcode-provider/server/provider.ts`
- Create: `plugins/zcode-provider/server/capabilities.ts`
- Create: `plugins/zcode-provider/server/internal/binary.ts`
- Modify: `packages/server/src/server/plugins/builtin/index.ts:5-19` — add the plugin to the bundled plugin list
- Test: `plugins/zcode-provider/server/internal/binary.test.ts`

**Interfaces:**

- Consumes: `ProviderRegistration.resolveCommand?` from Task 1.
- Produces:
  - `resolveZCodeCommand(options: ZCodeDiscoveryOptions): Promise<readonly [string, ...string[]] | undefined>` — the discovery result, or `undefined` when nothing was found.
  - `ZCODE_NOT_FOUND_DIAGNOSTIC: string` — the diagnostic listing all four resolution paths.

- [ ] **Step 1: Write the failing test**

Create `plugins/zcode-provider/server/internal/binary.test.ts`:

```ts
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ZCODE_NOT_FOUND_DIAGNOSTIC, resolveZCodeCommand } from "./binary.js";

describe("ZCode binary discovery", () => {
  test("reports every resolution path when nothing is found", async () => {
    const empty = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const result = await resolveZCodeCommand({
      pathEntries: [empty],
      env: {},
      desktopRoots: [join(empty, "no-such-app")],
    });
    expect(result).toBeUndefined();
    for (const hint of ["agents.providers.zcode.command", "PATH", "desktop", "GLM_BINARY_PATH"]) {
      expect(ZCODE_NOT_FOUND_DIAGNOSTIC).toContain(hint);
    }
  });

  test("prefers the desktop bundle over the environment variable", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const bundleDir = join(root, "ZCode.app", "Contents", "Resources", "glm");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "zcode.cjs"), "// bundle\n");
    const fakeNode = join(root, "node");
    await writeFile(fakeNode, "#!/bin/sh\n");
    const result = await resolveZCodeCommand({
      pathEntries: [],
      env: { GLM_BINARY_PATH: join(root, "ignored") },
      desktopRoots: [join(root, "ZCode.app")],
      execPath: fakeNode,
    });
    expect(result?.[1]).toContain("zcode.cjs");
  });

  test("uses an executable named zcode found on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bin-"));
    const binary = join(root, "zcode");
    await writeFile(binary, "#!/bin/sh\n");
    // The discovery checks the executable bit, so the fixture needs it.
    await chmod(binary, 0o755);
    const result = await resolveZCodeCommand({
      pathEntries: [root],
      env: {},
      desktopRoots: [],
    });
    expect(result?.[0]).toBe(binary);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/internal/binary.test.ts --bail=1`
Expected: FAIL with "Cannot find module './binary.js'".

- [ ] **Step 3: Write the discovery module**

Create `plugins/zcode-provider/server/internal/binary.ts`:

```ts
import { access, constants, readdir } from "node:fs/promises";
import { join } from "node:path";

export const ZCODE_NOT_FOUND_DIAGNOSTIC = [
  "ZCode was not found.",
  "Install the ZCode CLI (@zcode/cli) so `zcode` is on PATH, or set",
  "agents.providers.zcode.command, or install the ZCode desktop app so its",
  "bundled runtime is discovered, or set GLM_BINARY_PATH.",
].join(" ");

export interface ZCodeDiscoveryOptions {
  /** PATH entries to search for a `zcode` executable. */
  pathEntries: readonly string[];
  /** Environment to consult, including GLM_BINARY_PATH. */
  env: Readonly<Record<string, string | undefined>>;
  /** Roots that may contain a ZCode desktop app bundle. */
  desktopRoots: readonly string[];
  /** Runtime used to execute a bundled JavaScript entry. Defaults to this process. */
  execPath?: string;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(
  name: string,
  pathEntries: readonly string[],
): Promise<string | undefined> {
  for (const entry of pathEntries) {
    const candidate = join(entry, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function findDesktopBundle(
  desktopRoots: readonly string[],
): Promise<{ bundle: string; native: boolean } | undefined> {
  for (const root of desktopRoots) {
    const glmDir = join(root, "Contents", "Resources", "glm");
    const native = join(glmDir, "zcode-agent");
    if (await isExecutable(native)) return { bundle: native, native: true };
    const script = join(glmDir, "zcode.cjs");
    if (await isFile(script)) return { bundle: script, native: false };
  }
  return undefined;
}

export async function resolveZCodeCommand(
  options: ZCodeDiscoveryOptions,
): Promise<readonly [string, ...string[]] | undefined> {
  const onPath = await findOnPath("zcode", options.pathEntries);
  if (onPath) return [onPath, "app-server", "--stdio"];

  const bundled = await findDesktopBundle(options.desktopRoots);
  if (bundled) {
    if (bundled.native) return [bundled.bundle, "app-server", "--stdio"];
    return [options.execPath ?? process.execPath, bundled.bundle, "app-server", "--stdio"];
  }

  const fromEnv = options.env.GLM_BINARY_PATH?.trim();
  if (fromEnv && (await isExecutable(fromEnv))) return [fromEnv, "app-server", "--stdio"];

  return undefined;
}

export function defaultDesktopRoots(): readonly string[] {
  if (process.platform === "darwin") {
    return ["/Applications", join(process.env.HOME ?? "", "Applications")];
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? [join(localAppData, "Programs")] : [];
  }
  return ["/opt", "/usr/share"];
}

export async function listDesktopAppRoots(roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith("zcode")) found.push(join(root, entry));
    }
  }
  return found;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/zcode-provider/server/internal/binary.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Write the manifest, icon, and registration**

Create `plugins/zcode-provider/paseo-plugin.json`:

```json
{ "id": "zcode-provider", "requirements": { "paseo": ">=0.14.1-beta.1" } }
```

Create `plugins/zcode-provider/icon.svg` as a single-color, `currentColor` SVG with `viewBox="0 0 24 24"` and no external references.

Create `plugins/zcode-provider/server/capabilities.ts`:

```ts
import type { ProviderCapability } from "@getpaseo/plugin/server/provider";

/**
 * The capabilities the legacy ZCode transport can deliver.
 * The V4 transport adds session.revert.* and prompt.steer.
 */
export const ZCODE_CAPABILITIES = [
  "prompt.message",
  "permission",
  "permission.tool_policy",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.archive",
  "session.unarchive",
  "session.can_stop_runtime",
  "session.subsession",
  "timeline.plugin",
] as const satisfies readonly ProviderCapability[];
```

The capabilities live in their own module because the transport imports them and the transport is imported by the provider. Keeping them in `provider.ts` would make the two modules import each other.

Create `plugins/zcode-provider/index.server.ts`:

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createZCodeProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createZCodeProvider());
  return () => {};
}
```

`@getpaseo/plugin/server` exports `PluginServerContext` as a type and the `spawnProcess`, `execCommand`, `terminateProcess`, and `defineAgentTool` values. There is no `registerProvider` export; the registration happens through the server context the daemon hands the plugin. Every bundled plugin in `plugins/` uses this shape.

Create `plugins/zcode-provider/server/provider.ts`:

```ts
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderRegistration,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { ZCODE_CAPABILITIES } from "./capabilities.js";
import {
  ZCODE_NOT_FOUND_DIAGNOSTIC,
  defaultDesktopRoots,
  listDesktopAppRoots,
  resolveZCodeCommand,
} from "./internal/binary.js";

export function createZCodeProvider(): ProviderRegistration {
  return {
    id: "zcode",
    label: "ZCode",
    description: "ZCode agent on your host, driven over its app-server protocol",
    icon: "icon.svg",
    async resolveCommand() {
      return resolveCommand();
    },
    async status({ launch }): Promise<ProviderStatus> {
      if (!launch) {
        return { available: false, diagnostic: ZCODE_NOT_FOUND_DIAGNOSTIC };
      }
      return { available: true, diagnostic: `ZCode resolved to ${launch.command}` };
    },
    async connect(request) {
      const negotiated = negotiateProviderCapabilities(request.capabilities, ZCODE_CAPABILITIES);
      return createConnection(negotiated);
    },
  };
}

/**
 * The daemon probes availability whenever it lists providers and before every
 * connection. Resolution scans PATH and the desktop app roots, so the result is
 * memoized briefly instead of repeating the scan on every probe.
 */
const RESOLUTION_CACHE_MS = 5_000;
let cached: { at: number; value: readonly [string, ...string[]] | undefined } | undefined;

async function resolveCommand(): Promise<readonly [string, ...string[]] | undefined> {
  const now = Date.now();
  if (cached && now - cached.at < RESOLUTION_CACHE_MS) return cached.value;
  const value = await resolveZCodeCommand({
    pathEntries: (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"),
    env: process.env,
    desktopRoots: await listDesktopAppRoots(defaultDesktopRoots()),
  });
  cached = { at: now, value };
  return value;
}
```

`createConnection` is added in Task 9. Until then, stub it:

```ts
function createConnection(_capabilities: readonly string[]): ProviderConnection {
  throw new Error("ZCode connection is not wired yet");
}
```

- [ ] **Step 6: Register the plugin as a bundled plugin**

A bundled plugin is only loaded if it appears in the `builtinPlugins` list in `packages/server/src/server/plugins/builtin/index.ts`. Add the id to that list, keeping the list alphabetical:

```ts
export const builtinPlugins = [
  "antigravity-provider",
  "claude-usage-source",
  "codex-usage-source",
  "copilot-usage-source",
  "cursor-usage-source",
  "grok-usage-source",
  "hoplite-provider",
  "kimi-usage-source",
  "minimax-usage-source",
  "muse-provider",
  "opencode-go-usage-source",
  "worktree-include",
  "zai-usage-source",
  "zcode-provider",
] as const;
```

This is not a provider manifest entry, a provider factory, or a protocol-layer provider id. The daemon still learns about ZCode only through the plugin's own registration.

`scripts/builtin-plugins-dist.test.mjs` iterates `builtinPlugins` and asserts that every listed plugin has a manifest whose id matches, compiles, and starts. Adding the id there brings the packaged build under that test for free.

- [ ] **Step 7: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add plugins/zcode-provider packages/server/src/server/plugins/builtin/index.ts
git commit -m "feat(plugins): add the ZCode provider skeleton and binary discovery

Resolve the ZCode executable from PATH, from the runtime bundled in the
ZCode desktop app, or from GLM_BINARY_PATH, and report every path in the
diagnostic when none of them resolve."
```

---

### Task 3: Tolerant frame decoding

ZCode's schemas are strict and keep gaining fields. A decoder that mirrors that strictness drops whole turns when ZCode adds one.

**Files:**

- Create: `plugins/zcode-provider/server/internal/wire.ts`
- Test: `plugins/zcode-provider/server/internal/wire.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `decodeFrame(line: string): ZCodeFrame | undefined`
  - `encodeRequest(id: string, method: string, params?: unknown): string`
  - `ZCodeError` — an error carrying a numeric protocol code.

- [ ] **Step 1: Write the failing test**

Create `plugins/zcode-provider/server/internal/wire.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { decodeFrame, encodeRequest } from "./wire.js";

describe("ZCode frame decoding", () => {
  test("keeps an event that carries an unknown field", () => {
    const frame = decodeFrame(
      JSON.stringify({
        eventId: "e1",
        sessionId: "s1",
        seq: 3,
        timestamp: 1_700_000_000_000,
        type: "message.upserted",
        payload: { content: "hello" },
        futureField: { anything: true },
      }),
    );
    expect(frame).toMatchObject({
      kind: "event",
      event: { type: "message.upserted", sessionId: "s1", seq: 3 },
    });
  });

  test("ignores an event type it does not know", () => {
    const frame = decodeFrame(
      JSON.stringify({
        eventId: "e2",
        sessionId: "s1",
        seq: 4,
        timestamp: 1_700_000_000_000,
        type: "some.future.event",
        payload: {},
      }),
    );
    expect(frame).toBeUndefined();
  });

  test("returns undefined for a broken frame instead of throwing", () => {
    expect(decodeFrame("{not json")).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ id: "1" }))).toBeUndefined();
  });

  test("decodes a response and a protocol error", () => {
    expect(decodeFrame(JSON.stringify({ id: "1", result: { ok: true } }))).toMatchObject({
      kind: "response",
      id: "1",
    });
    const failure = decodeFrame(
      JSON.stringify({ id: "2", error: { code: -32000, message: "boom" } }),
    );
    expect(failure).toMatchObject({ kind: "error", id: "2" });
  });

  test("encodes a request without a jsonrpc field", () => {
    const line = encodeRequest("7", "session/send", { sessionId: "s1", content: "hi" });
    expect(JSON.parse(line)).toEqual({
      id: "7",
      method: "session/send",
      params: { sessionId: "s1", content: "hi" },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/internal/wire.test.ts --bail=1`
Expected: FAIL with "Cannot find module './wire.js'".

- [ ] **Step 3: Write the frame module**

Create `plugins/zcode-provider/server/internal/wire.ts`:

```ts
import { z } from "zod";

const eventFrameSchema = z
  .object({
    eventId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    seq: z.number().int().nonnegative(),
    timestamp: z.number(),
    type: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .passthrough();

const responseFrameSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .optional(),
  })
  .passthrough()
  // A response frame carries a result or an error. Without this, a bare
  // `{ id }` frame parses as a successful response with an undefined result,
  // and the pending request resolves with nothing.
  .refine((value) => value.result !== undefined || value.error !== undefined, {
    message: "A response frame carries a result or an error",
  });

export type ZCodeEventFrame = z.infer<typeof eventFrameSchema>;

/**
 * A request ZCode sends to the host. ZCode asks the host for permission with
 * one, so the host has to answer it.
 */
const requestFrameSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

export interface ZCodeRequestFrame {
  id: string;
  method: string;
  params?: unknown;
}

export type ZCodeFrame =
  | { kind: "request"; request: ZCodeRequestFrame }
  | { kind: "event"; event: ZCodeEventFrame }
  | { kind: "response"; id: string; result: unknown }
  | { kind: "error"; id: string; code: number; message: string; data?: unknown };

export class ZCodeError extends Error {
  constructor(
    message: string,
    readonly code = "ZCODE_ERROR",
    readonly protocolCode?: number,
  ) {
    super(message);
    this.name = "ZCodeError";
  }
}

export function decodeFrame(line: string): ZCodeFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const request = requestFrameSchema.safeParse(parsed);
  if (request.success) {
    return {
      kind: "request",
      request: {
        id: String(request.data.id),
        method: request.data.method,
        params: request.data.params,
      },
    };
  }
  const event = eventFrameSchema.safeParse(parsed);
  if (event.success) return { kind: "event", event: event.data };
  const response = responseFrameSchema.safeParse(parsed);
  if (!response.success) return undefined;
  if (response.data.error) {
    return {
      kind: "error",
      id: String(response.data.id),
      code: response.data.error.code,
      message: response.data.error.message,
      data: response.data.error.data,
    };
  }
  return { kind: "response", id: String(response.data.id), result: response.data.result };
}

export function encodeRequest(id: string, method: string, params?: unknown): string {
  const frame: Record<string, unknown> = { id, method };
  if (params !== undefined) frame.params = params;
  return `${JSON.stringify(frame)}\n`;
}

export function encodeResponse(id: string, result: unknown): string {
  return `${JSON.stringify({ id, result })}\n`;
}

export function encodeError(id: string, code: number, message: string): string {
  return `${JSON.stringify({ id, error: { code, message } })}\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/zcode-provider/server/internal/wire.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/zcode-provider/server/internal/wire.ts plugins/zcode-provider/server/internal/wire.test.ts
git commit -m "feat(plugins): decode ZCode frames without mirroring their strictness"
```

---

### Task 4: JSON-RPC client over a writable stream

**Files:**

- Create: `plugins/zcode-provider/server/internal/rpc.ts`
- Test: `plugins/zcode-provider/server/internal/rpc.test.ts`

**Interfaces:**

- Consumes: `decodeFrame`, `encodeRequest`, `encodeResponse`, `encodeError`, `ZCodeError`, `ZCodeEventFrame`, `ZCodeRequestFrame` from Task 3.
- Produces:
  - `class ZCodeRpcClient` with `call(method, params): Promise<unknown>`, `onEvent(listener): () => void`, `onRequest(listener): () => void`, `write(line: string): void`, `close(): void`.
  - `isMethodNotFound(error): boolean` — a standalone export, not a static member.

- [ ] **Step 1: Write the failing test**

Create `plugins/zcode-provider/server/internal/rpc.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { ZCodeRpcClient, isMethodNotFound } from "./rpc.js";

/**
 * The base client has no output stream; it throws when a call writes. The
 * process layer supplies one, so the test supplies one too.
 */
class TestRpcClient extends ZCodeRpcClient {
  readonly written: string[] = [];

  protected override write(line: string): void {
    this.written.push(line);
  }
}

describe("ZCode RPC client", () => {
  test("resolves a call when the matching response arrives", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/read", { sessionId: "s1" });
    client.receive(JSON.stringify({ id: "1", result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
  });

  test("writes the encoded request with its own id", () => {
    const client = new TestRpcClient();
    void client.call("session/read", { sessionId: "s1" }).catch(() => undefined);
    expect(JSON.parse(client.written[0]!)).toEqual({
      id: "1",
      method: "session/read",
      params: { sessionId: "s1" },
    });
  });

  test("rejects a call when the protocol answers with an error", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/read", { sessionId: "s1" });
    client.receive(JSON.stringify({ id: "1", error: { code: -32601, message: "no method" } }));
    await expect(pending).rejects.toThrow("no method");
  });

  test("recognizes a method-not-found failure", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/steer", { sessionId: "s1" });
    client.receive(JSON.stringify({ id: "1", error: { code: -32601, message: "no method" } }));
    const error = await pending.catch((value: unknown) => value);
    expect(isMethodNotFound(error)).toBe(true);
  });

  test("dispatches events to listeners and survives a broken frame", () => {
    const client = new TestRpcClient();
    const seen: string[] = [];
    client.onEvent((event) => seen.push(event.type));
    client.receive("{broken");
    client.receive(
      JSON.stringify({
        eventId: "e1",
        sessionId: "s1",
        seq: 1,
        timestamp: 1,
        type: "turn.started",
      }),
    );
    expect(seen).toEqual(["turn.started"]);
  });

  test("rejects every pending call when the connection closes", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/read", { sessionId: "s1" });
    client.close();
    await expect(pending).rejects.toThrow(/closed/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/internal/rpc.test.ts --bail=1`
Expected: FAIL with "Cannot find module './rpc.js'".

- [ ] **Step 3: Write the client**

Create `plugins/zcode-provider/server/internal/rpc.ts`:

```ts
import {
  decodeFrame,
  encodeError,
  encodeRequest,
  encodeResponse,
  type ZCodeEventFrame,
  type ZCodeRequestFrame,
} from "./wire.js";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class ZCodeMethodNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZCodeMethodNotFoundError";
  }
}

export function isMethodNotFound(error: unknown): boolean {
  return error instanceof ZCodeMethodNotFoundError;
}

export class ZCodeRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Set<(event: ZCodeEventFrame) => void>();
  private readonly requestListeners = new Set<
    (request: ZCodeRequestFrame) => Promise<unknown> | unknown
  >();
  private closed = false;

  call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ZCode connection is closed"));
    const id = String(this.nextId++);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(encodeRequest(id, method, params));
    });
  }

  onEvent(listener: (event: ZCodeEventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * ZCode asks the host for permission with a reverse request, so the client
   * has to answer requests as well as make them. The handler's resolved value
   * is sent back as the response.
   */
  onRequest(listener: (request: ZCodeRequestFrame) => Promise<unknown> | unknown): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  private async handleRequest(frame: ZCodeRequestFrame): Promise<void> {
    for (const listener of this.requestListeners) {
      try {
        const result = await listener(frame);
        this.write(encodeResponse(frame.id, result));
        return;
      } catch (error) {
        this.write(
          encodeError(frame.id, -32603, error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }
    this.write(encodeError(frame.id, -32601, `Unknown method: ${frame.method}`));
  }

  receive(line: string): void {
    const frame = decodeFrame(line);
    if (!frame) return;
    if (frame.kind === "event") {
      for (const listener of this.listeners) listener(frame.event);
      return;
    }
    if (frame.kind === "request") {
      void this.handleRequest(frame.request);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.kind === "error") {
      pending.reject(
        frame.code === -32601
          ? new ZCodeMethodNotFoundError(frame.message)
          : Object.assign(new Error(frame.message), { protocolCode: frame.code }),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  close(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("ZCode connection closed before the response arrived"));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  /** Overridden by the process layer to write a framed line to the child. */
  protected write(_line: string): void {
    throw new Error("ZCode RPC client has no output stream");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/zcode-provider/server/internal/rpc.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/zcode-provider/server/internal/rpc.ts plugins/zcode-provider/server/internal/rpc.test.ts
git commit -m "feat(plugins): add the ZCode JSON-RPC client"
```

---

### Task 5: Process lifecycle

**Files:**

- Create: `plugins/zcode-provider/server/internal/process.ts`
- Create: `plugins/zcode-provider/test/fake-zcode-app-server.mjs`
- Test: `plugins/zcode-provider/server/internal/process.test.ts`

**Interfaces:**

- Consumes: `ZCodeRpcClient` from Task 4.
- Produces:
  - `startZCodeProcess(options): ZCodeProcess` where `ZCodeProcess` exposes `rpc: ZCodeRpcClient`, `stderr(): string`, `exit(): Promise<void>`.
  - `ZCodeProcess.startupError` — set when the child failed to start.

- [ ] **Step 1: Write the fake app-server**

Create `plugins/zcode-provider/test/fake-zcode-app-server.mjs`:

```js
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const mode = process.env.FAKE_ZCODE_MODE ?? "ok";

for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (mode === "exit") {
    process.exit(3);
  }
  if (mode === "stderr") {
    process.stderr.write("ZCode runtime missing\n");
    process.exit(1);
  }
  const id = request.id;
  if (request.method === "session/events") {
    process.stdout.write(`${JSON.stringify({ id, result: { events: [] } })}\n`);
    continue;
  }
  if (request.method === "session/send") {
    if (mode !== "permission") {
      pushTurn(request.params.sessionId, request.params.inputId, request.params.content);
      process.stdout.write(
        `${JSON.stringify({ id, result: { sessionId: request.params.sessionId, accepted: true, stateRevision: 1 } })}\n`,
      );
      continue;
    }
    // ZCode asks the host for permission with a reverse request and waits
    // for that request's answer before the turn runs.
    pendingTurn = {
      requestId: id,
      sessionId: request.params.sessionId,
      inputId: request.params.inputId,
      content: request.params.content,
    };
    process.stdout.write(
      `${JSON.stringify({
        id: "perm-1",
        method: "interaction/requestPermission",
        params: {
          requestId: "perm-1",
          sessionId: request.params.sessionId,
          toolCallId: "t1",
          toolName: "bash",
          reason: "run a command",
          riskLevel: "low",
          input: { command: "ls" },
          options: [
            {
              optionId: "allow",
              kind: "allow_always",
              name: "Allow",
              response: { decision: "allow" },
            },
            { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
          ],
        },
      })}\n`,
    );
    continue;
  }
  process.stdout.write(`${JSON.stringify({ id, result: {} })}\n`);
}
```

- [ ] **Step 2: Write the failing test**

Create `plugins/zcode-provider/server/internal/process.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { startZCodeProcess } from "./process.js";

const fakeServer = fileURLToPath(new URL("../../test/fake-zcode-app-server.mjs", import.meta.url));

describe("ZCode process lifecycle", () => {
  test("answers a call over the child's stdio", async () => {
    // The binding is not named `process`: it would shadow the global inside
    // its own initializer and `process.execPath` would throw a TDZ error.
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
    });
    await expect(zcode.rpc.call("session/read", { sessionId: "s1" })).resolves.toEqual({});
    await zcode.exit();
  });

  test("reports a startup failure with the child's stderr", async () => {
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "stderr" },
    });
    await expect(zcode.ready).rejects.toThrow(/runtime missing/);
    await zcode.exit();
  });
});
```

`spawnProcess` hands `options.env` to the child as-is; the child does not inherit `process.env`. A test that passes only `FAKE_ZCODE_MODE` gives the child an environment with nothing else in it. The real connection passes the daemon-owned launch environment, which is already complete.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/internal/process.test.ts --bail=1`
Expected: FAIL with "Cannot find module './process.js'".

- [ ] **Step 4: Write the process module**

Create `plugins/zcode-provider/server/internal/process.ts`:

```ts
import { spawnProcess } from "@getpaseo/plugin/server";
import { createInterface } from "node:readline";
import { ZCodeRpcClient } from "./rpc.js";

export interface ZCodeProcessOptions {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface ZCodeProcess {
  rpc: ZCodeRpcClient;
  /** Resolves once the child answered its first request. Rejects on startup failure. */
  ready: Promise<void>;
  stderr(): string;
  exit(): Promise<void>;
}

class ProcessRpcClient extends ZCodeRpcClient {
  constructor(private readonly writeLine: (line: string) => void) {
    super();
  }

  protected override write(line: string): void {
    this.writeLine(line);
  }
}

export function startZCodeProcess(options: ZCodeProcessOptions): ZCodeProcess {
  const child = spawnProcess(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: "pipe",
    detached: process.platform !== "win32",
  });

  let stderrText = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const rpc = new ProcessRpcClient((line) => {
    child.stdin?.write(line);
  });

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    rpc.receive(line);
  });

  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);

  child.on("exit", (code) => {
    const error = new Error(
      `ZCode exited with code ${code ?? "unknown"}.${stderrText ? ` ${stderrText.trim()}` : ""}`,
    );
    rejectReady(error);
    rpc.close();
  });
  child.on("error", (error) => {
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  });

  // The child is ready once it answers a request.
  void rpc
    .call("runtime/capabilities", {})
    .then(() => resolveReady())
    .catch((error) => rejectReady(error instanceof Error ? error : new Error(String(error))));

  return {
    rpc,
    ready,
    stderr: () => stderrText,
    async exit() {
      rpc.close();
      child.stdin?.end();
      child.kill();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run plugins/zcode-provider/server/internal/process.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/zcode-provider/server/internal/process.ts plugins/zcode-provider/server/internal/process.test.ts plugins/zcode-provider/test/fake-zcode-app-server.mjs
git commit -m "feat(plugins): run the ZCode app-server as a child process"
```

---

### Task 6: Legacy transport and the event cursor

**Files:**

- Create: `plugins/zcode-provider/server/internal/transport.ts`
- Create: `plugins/zcode-provider/server/internal/legacy-transport.ts`
- Test: `plugins/zcode-provider/server/internal/legacy-transport.test.ts`

**Interfaces:**

- Consumes: `ZCodeProcess` from Task 5, `ZCodeRpcClient` from Task 4.
- Produces:
  - `interface ZCodeTransport` with `capabilities`, `createSession`, `resumeSession`, `send`, `stop`, `archive`, `readSnapshot`, `listSessions`, `setModel`, `setMode`, `setThoughtLevel`, `onEvent`, `onRequest`, `close`.
  - `createLegacyTransport(process): ZCodeTransport`.

- [ ] **Step 1: Write the failing test**

Create `plugins/zcode-provider/server/internal/legacy-transport.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { startZCodeProcess } from "./process.js";
import { createLegacyTransport } from "./legacy-transport.js";

const fakeServer = fileURLToPath(new URL("../../test/fake-zcode-app-server.mjs", import.meta.url));

describe("legacy ZCode transport", () => {
  test("sends a prompt and acknowledges it", async () => {
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
    });
    const transport = createLegacyTransport(zcode);
    await transport.createSession({
      workspacePath: "/tmp/project",
      workspaceKey: "/tmp/project",
    });
    await expect(
      transport.send({ sessionId: "s1", content: "hello", inputId: "input-1" }),
    ).resolves.toBeUndefined();
    await transport.close();
  });

  test("does not advertise rewind or steer", () => {
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
    });
    const transport = createLegacyTransport(zcode);
    expect(transport.capabilities).not.toContain("session.revert.conversation");
    expect(transport.capabilities).not.toContain("prompt.steer");
    expect(transport.capabilities).toContain("prompt.message");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/internal/legacy-transport.test.ts --bail=1`
Expected: FAIL with "Cannot find module './transport.js'".

- [ ] **Step 3: Write the transport interface**

Create `plugins/zcode-provider/server/internal/transport.ts`:

```ts
import type { ZCodeSessionSettings } from "./catalog.js";

export type { ZCodeRequestFrame } from "./wire.js";

export interface ZCodeWorkspaceRef {
  workspacePath: string;
  workspaceKey: string;
}

export interface ZCodeSessionHandle {
  sessionId: string;
  workspace: ZCodeWorkspaceRef;
}

export interface ZCodeTransport {
  readonly capabilities: readonly string[];
  createSession(input: {
    workspace: ZCodeWorkspaceRef;
    mode?: string;
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeSessionHandle>;
  resumeSession(input: {
    sessionId: string;
    workspace?: ZCodeWorkspaceRef;
  }): Promise<ZCodeSessionHandle>;
  send(input: { sessionId: string; content: string; inputId: string }): Promise<void>;
  stop(input: { sessionId: string }): Promise<void>;
  /** Closes the ZCode session without ending the app-server process. */
  archive(input: { sessionId: string }): Promise<void>;
  /**
   * ZCode asks the host for permission with a reverse request and waits for
   * the answer, so the host has to answer requests as well as make them.
   */
  onRequest(listener: (request: ZCodeRequestFrame) => Promise<unknown> | unknown): () => void;
  /**
   * Reads a session snapshot. ZCode returns its model, mode and thought-level
   * options on the snapshot, so the catalog is read through a session.
   */
  readSnapshot(input: { sessionId: string }): Promise<{ settings?: ZCodeSessionSettings }>;
  listSessions(input: { workspace?: ZCodeWorkspaceRef; limit?: number }): Promise<unknown[]>;
  setModel(input: { sessionId: string; model: string }): Promise<void>;
  setMode(input: { sessionId: string; mode: string }): Promise<void>;
  setThoughtLevel(input: { sessionId: string; thoughtLevel: string }): Promise<void>;
  onEvent(listener: (event: ZCodeEvent) => void): () => void;
  close(): Promise<void>;
}

export type ZCodeEvent = {
  type: string;
  sessionId: string;
  turnId?: string;
  seq: number;
  payload: unknown;
};
```

- [ ] **Step 4: Write the legacy transport**

Create `plugins/zcode-provider/server/internal/legacy-transport.ts`:

```ts
import { ZCODE_CAPABILITIES } from "../capabilities.js";
import type { ZCodeProcess } from "./process.js";
import type {
  ZCodeEvent,
  ZCodeRequestFrame,
  ZCodeSessionHandle,
  ZCodeTransport,
  ZCodeWorkspaceRef,
} from "./transport.js";

export const LEGACY_POLL_INTERVAL_MS = 200;

/**
 * ZCode's model picker value is "providerId/modelId", and the protocol wants
 * the two parts separately (`packages/shared/src/model-selection.ts:34-44` in
 * the ZCode repository). The catalog hands the provider the picker value as
 * the model id, so this is the inverse of what the catalog produced.
 */
function toModelSelection(value: string): { providerId: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`ZCode model id is not a provider and model pair: ${value}`);
  }
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

export function createLegacyTransport(process: ZCodeProcess): ZCodeTransport {
  const cursors = new Map<string, number>();
  const listeners = new Set<(event: ZCodeEvent) => void>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let polling = false;

  async function poll(): Promise<void> {
    // setInterval does not wait for the previous tick. A poll that outlives the
    // interval would read the same cursor twice and deliver every event twice.
    if (polling) return;
    polling = true;
    try {
      for (const [sessionId, cursor] of cursors) {
        try {
          const result = (await process.rpc.call("session/events", {
            sessionId,
            afterSeq: cursor,
          })) as { events?: unknown[] };
          for (const raw of result?.events ?? []) {
            const event = raw as {
              type?: string;
              sessionId?: string;
              turnId?: string;
              seq?: number;
              payload?: unknown;
            };
            if (!event.type || !event.sessionId || typeof event.seq !== "number") continue;
            cursors.set(sessionId, event.seq);
            const mapped: ZCodeEvent = {
              type: event.type,
              sessionId: event.sessionId,
              turnId: event.turnId,
              seq: event.seq,
              payload: event.payload,
            };
            for (const listener of listeners) listener(mapped);
          }
        } catch {
          // A failed poll is retried on the next tick; the session's own
          // error path reports the failure if the process is gone.
        }
      }
    } finally {
      polling = false;
    }
  }

  function startPolling(): void {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void poll();
    }, LEGACY_POLL_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    capabilities: ZCODE_CAPABILITIES,
    async createSession(input) {
      const result = (await process.rpc.call("session/create", {
        workspace: {
          workspacePath: input.workspace.workspacePath,
          workspaceKey: input.workspace.workspaceKey,
        },
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.model ? { model: toModelSelection(input.model) } : {}),
        ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
      })) as { sessionId?: string };
      if (!result?.sessionId) throw new Error("ZCode did not return a session id");
      cursors.set(result.sessionId, 0);
      startPolling();
      return { sessionId: result.sessionId, workspace: input.workspace };
    },
    async resumeSession(input) {
      const workspace = input.workspace ?? {
        workspacePath: input.sessionId,
        workspaceKey: input.sessionId,
      };
      await process.rpc.call("session/resume", {
        sessionId: input.sessionId,
        workspace,
      });
      cursors.set(input.sessionId, 0);
      startPolling();
      return { sessionId: input.sessionId, workspace };
    },
    async send(input) {
      await process.rpc.call("session/send", {
        sessionId: input.sessionId,
        content: input.content,
        inputId: input.inputId,
      });
    },
    async stop(input) {
      await process.rpc.call("session/stop", { sessionId: input.sessionId });
    },
    async listSessions(input) {
      const result = (await process.rpc.call("session/list", {
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      })) as { sessions?: unknown[] };
      return result?.sessions ?? [];
    },
    async setModel(input) {
      await process.rpc.call("session/setModel", {
        sessionId: input.sessionId,
        model: toModelSelection(input.model),
      });
    },
    async setMode(input) {
      await process.rpc.call("session/setMode", {
        sessionId: input.sessionId,
        mode: input.mode,
      });
    },
    async setThoughtLevel(input) {
      await process.rpc.call("session/setThoughtLevel", {
        sessionId: input.sessionId,
        thoughtLevel: input.thoughtLevel,
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      stopped = true;
      if (timer) clearInterval(timer);
      cursors.clear();
      listeners.clear();
    },
  };
}
```

**Method-not-found downgrade.** ZCode's protocol answers a removed method with `-32601`. That is the only failure that may be downgraded: the capability goes away and the rest of the provider keeps working. Any other failure propagates.

Add to the legacy transport:

```ts
const unavailable = new Set<string>();

async function call(method: string, params?: unknown): Promise<unknown> {
  try {
    return await process.rpc.call(method, params);
  } catch (error) {
    if (isMethodNotFound(error)) {
      unavailable.add(method);
      return undefined;
    }
    throw error;
  }
}
```

Replace every `process.rpc.call(...)` in the transport with `call(...)`, and expose the unavailable set so the connection can drop the matching capability:

```ts
// In ZCodeTransport:
readonly unavailableMethods: ReadonlySet<string>;
```

The connection removes a capability when its method is unavailable. The mapping lives next to the transport:

```ts
const CAPABILITY_METHODS: Record<string, string> = {
  "prompt.command": "session/command",
  "session.subsession": "session/subagents",
  "session.can_stop_runtime": "session/read",
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run plugins/zcode-provider/server/internal/legacy-transport.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/zcode-provider/server/internal/transport.ts plugins/zcode-provider/server/internal/legacy-transport.ts plugins/zcode-provider/server/internal/legacy-transport.test.ts
git commit -m "feat(plugins): add the legacy ZCode transport and its event cursor"
```

---

### Task 7: Turn state machine and the stop boundary

This task owns the rule that a cancel which has not settled blocks new runs.

**Files:**

- Create: `plugins/zcode-provider/server/internal/session.ts`
- Test: `plugins/zcode-provider/server/internal/session.test.ts`

**Interfaces:**

- Consumes: `ZCodeTransport`, `ZCodeEvent` from Task 6.
- Produces:
  - `class ZCodeSession` with `open`, `prompt`, `interrupt`, `configure`, and `close`. It subscribes to the transport's events; it does not expose an `onEvent` hook of its own.
  - `type TurnPhase = "idle" | "running" | "stopping" | "settled"`.

- [ ] **Step 1: Write the failing test**

Create `plugins/zcode-provider/server/internal/session.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { ZCodeSession } from "./session.js";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { ZCodeEvent, ZCodeTransport } from "./transport.js";

/**
 * A ProviderPrompt carries a delivery mode and a content array. There is no
 * `text` field.
 */
function textPrompt(clientMessageId: string, text: string): ProviderPrompt {
  return {
    clientMessageId,
    delivery: "auto",
    input: { type: "message", content: [{ type: "text", text }] },
  };
}

function fakeTransport() {
  const sent: Array<{ method: string; params: unknown }> = [];
  const listeners = new Set<(event: ZCodeEvent) => void>();
  const transport: ZCodeTransport = {
    capabilities: ["prompt.message", "permission"],
    createSession: async () => ({
      sessionId: "zcode-1",
      workspace: { workspacePath: "/w", workspaceKey: "/w" },
    }),
    resumeSession: async () => ({
      sessionId: "zcode-1",
      workspace: { workspacePath: "/w", workspaceKey: "/w" },
    }),
    send: async (input) => {
      sent.push({ method: "send", params: input });
    },
    stop: async (input) => {
      sent.push({ method: "stop", params: input });
    },
    listSessions: async () => [],
    setModel: async () => undefined,
    setMode: async () => undefined,
    setThoughtLevel: async () => undefined,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => undefined,
  };
  return {
    transport,
    sent,
    emit(event: ZCodeEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("ZCode session turn state", () => {
  test("acknowledges a prompt with the turn id it generated", async () => {
    const harness = fakeTransport();
    const events: unknown[] = [];
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: (event) => events.push(event),
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        result: expect.objectContaining({ type: "turn" }),
      }),
    );
    expect(harness.sent[0]?.params).toMatchObject({ inputId: expect.any(String) });
  });

  test("a second interrupt retries the cancel instead of opening a second one", async () => {
    const harness = fakeTransport();
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: () => undefined,
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    const first = session.interrupt();
    const second = session.interrupt();
    await Promise.all([first, second]);
    expect(harness.sent.filter((entry) => entry.method === "stop")).toHaveLength(1);
  });

  test("refuses a new prompt while a cancel is unsettled", async () => {
    const harness = fakeTransport();
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: () => undefined,
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    void session.interrupt();
    await expect(session.prompt(textPrompt("m2", "again"))).rejects.toThrow(/cancel/i);
  });

  test("a failed cancel keeps refusing new prompts", async () => {
    const harness = fakeTransport();
    harness.transport.stop = async () => {
      throw new Error("stop failed");
    };
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: () => undefined,
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    await expect(session.interrupt()).rejects.toThrow("stop failed");
    await expect(session.prompt(textPrompt("m2", "again"))).rejects.toThrow(/cancel/i);
  });

  test("a stopped turn reaches a terminal and the session accepts a new prompt", async () => {
    const harness = fakeTransport();
    const events: ProviderEvent[] = [];
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: (event) => events.push(event),
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "hello"));
    await session.interrupt();
    const turns = events.filter((event) => event.type === "session.turn");
    expect(turns.some((event) => event.state === "canceled")).toBe(true);
    // The session must leave the stopping phase, or it refuses every later run.
    await expect(session.prompt(textPrompt("m2", "again"))).resolves.toBeUndefined();
  });

  test("attributes each turn's completion to the turn that started it", async () => {
    const harness = fakeTransport();
    const events: ProviderEvent[] = [];
    const session = new ZCodeSession({
      id: "paseo-1",
      transport: harness.transport,
      emit: (event) => events.push(event),
    });
    await session.open({ cwd: "/w" });
    await session.prompt(textPrompt("m1", "first"));
    await session.prompt(textPrompt("m2", "second"));

    harness.emit({
      type: "turn.started",
      sessionId: "zcode-1",
      turnId: "native-1",
      seq: 1,
      payload: { inputId: "paseo-input-m1" },
    });
    harness.emit({
      type: "turn.started",
      sessionId: "zcode-1",
      turnId: "native-2",
      seq: 2,
      payload: { inputId: "paseo-input-m2" },
    });
    harness.emit({
      type: "turn.completed",
      sessionId: "zcode-1",
      turnId: "native-1",
      seq: 3,
      payload: {},
    });

    const turns = events.filter((event) => event.type === "session.turn");
    const started = turns.filter((event) => event.state === "started");
    const completed = turns.filter((event) => event.state === "completed");
    expect(started).toHaveLength(2);
    expect(started[0]!.turnId).not.toBe(started[1]!.turnId);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.turnId).toBe(started[0]!.turnId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/internal/session.test.ts --bail=1`
Expected: FAIL with "Cannot find module './session.js'".

- [ ] **Step 3: Write the session**

Create `plugins/zcode-provider/server/internal/session.ts`:

```ts
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { ZCodeEvent, ZCodeTransport } from "./transport.js";

export type TurnPhase = "idle" | "running" | "stopping" | "settled";

interface ActiveTurn {
  turnId: string;
  inputId: string;
  clientMessageId: string;
}

export interface ZCodeSessionOptions {
  id: string;
  transport: ZCodeTransport;
  emit(event: ProviderEvent): void;
}

export class ZCodeSession {
  private phase: TurnPhase = "idle";
  /**
   * Turns are tracked per input id, not in a single slot. A second prompt can
   * be dispatched while the first turn is still running, and a single slot
   * would attribute the first turn's completion to the second turn.
   */
  private readonly turns = new Map<string, ActiveTurn>();
  /** ZCode's own turn id to the Paseo turn id it corresponds to. */
  private readonly nativeTurnIds = new Map<string, string>();
  /** The most recently started turn, used when an event carries no usable id. */
  private activeTurnId: string | undefined;
  /** The Paseo turn ids that already have a terminal. */
  private readonly terminalTurns = new Set<string>();

  private nativeSessionId = "";
  private cancelInFlight: Promise<void> | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: ZCodeSessionOptions) {
    this.unsubscribe = options.transport.onEvent((event) => this.handleEvent(event));
  }

  async open(input: { cwd: string }): Promise<string> {
    const handle = await this.options.transport.createSession({
      workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
    });
    this.nativeSessionId = handle.sessionId;
    this.options.emit({
      type: "session.opened",
      sessionId: this.options.id,
      capabilities: this.options.transport.capabilities,
      restoration: "core",
      cwd: input.cwd,
      persistence: {
        version: 1,
        data: {
          nativeSessionId: handle.sessionId,
          workspaceKey: handle.workspace.workspaceKey,
          workspacePath: handle.workspace.workspacePath,
        },
      },
    });
    this.options.emit({ type: "session.ready", sessionId: this.options.id });
    return handle.sessionId;
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.cancelInFlight) {
      throw new Error("A cancel is still settling; wait for it before starting a new run");
    }
    if (this.phase === "stopping") {
      throw new Error("A cancel is still settling; wait for it before starting a new run");
    }
    if (prompt.delivery === "steer") {
      throw new Error("Steering is not supported on the legacy ZCode transport");
    }
    if (prompt.input.type === "command") {
      throw new Error("Slash commands are not supported on the legacy ZCode transport");
    }
    const unsupported = prompt.input.content.filter((part) => part.type !== "text");
    if (unsupported.length > 0) {
      // The daemon gates images behind prompt.image, which this transport does
      // not declare, so an image prompt never arrives. Attachments have no
      // capability gate, so the session rejects them itself. Dropping them
      // would run the turn without the content the user attached.
      throw new Error(
        `Attachments are not supported on the legacy ZCode transport: ${unsupported.map((part) => part.type).join(", ")}`,
      );
    }
    const text = prompt.input.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const turnId = `zcode-turn-${this.options.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputId = `paseo-input-${prompt.clientMessageId}`;
    this.phase = "running";
    this.turns.set(inputId, { turnId, inputId, clientMessageId: prompt.clientMessageId });
    await this.options.transport.send({
      sessionId: this.nativeSessionId,
      content: text,
      inputId,
    });
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
  }

  interrupt(): Promise<void> {
    if (this.cancelInFlight) return this.cancelInFlight;
    this.phase = "stopping";
    this.cancelInFlight = this.settleCancel(this.cancelTarget());
    return this.cancelInFlight;
  }

  /**
   * Runs the cancel and settles the turn it stopped. A cancel that lands leaves
   * the session ready for the next run. A cancel that fails leaves the session
   * in "stopping", because the turn may still be running in ZCode.
   */
  private async settleCancel(cancelledTurnId: string | undefined): Promise<void> {
    try {
      await this.options.transport.stop({ sessionId: this.nativeSessionId });
    } catch (error) {
      this.cancelInFlight = undefined;
      // The failed terminal is the caller's answer for the turn, not the end
      // of the stop: the session keeps refusing new runs until a stop lands.
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: cancelledTurnId ?? "zcode-turn-unknown",
        state: "failed",
        error: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    this.cancelInFlight = undefined;
    // The caller is owed a terminal. ZCode may or may not send one after
    // a stop, so the provider emits the terminal itself and ignores the
    // event that follows. The phase has to leave "stopping" too, or the
    // session refuses every later prompt.
    this.phase = "settled";
    if (cancelledTurnId) {
      // The turn is terminal. Remember that, so a terminal that ZCode sends
      // for it afterwards cannot flip it back to completed, and drop it from
      // the live turns so a later terminal cannot be attributed to it.
      this.terminalTurns.add(cancelledTurnId);
      for (const [key, value] of this.turns) {
        if (value.turnId === cancelledTurnId) this.turns.delete(key);
      }
      if (this.activeTurnId === cancelledTurnId) this.activeTurnId = undefined;
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: cancelledTurnId,
        state: "canceled",
      });
    }
  }

  /**
   * The turn a cancel applies to. ZCode stops the session's current turn, so
   * the turn that started natively wins. A turn that was dispatched but never
   * acknowledged by ZCode is still owed a terminal, so the most recently
   * dispatched turn is the fallback.
   */
  private cancelTarget(): string | undefined {
    return this.activeTurnId ?? [...this.turns.values()].at(-1)?.turnId;
  }

  private handleEvent(event: ZCodeEvent): void {
    if (event.type === "turn.started") {
      const payload = event.payload as { inputId?: string } | undefined;
      const turn = payload?.inputId ? this.turns.get(payload.inputId) : undefined;
      if (turn) {
        if (event.turnId) this.nativeTurnIds.set(event.turnId, turn.turnId);
        this.activeTurnId = turn.turnId;
        this.options.emit({
          type: "session.turn",
          sessionId: this.options.id,
          turnId: turn.turnId,
          state: "started",
        });
      }
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      // A turn ZCode names has to be one this session started. An event whose
      // turn id the session never mapped belongs to a turn it did not run.
      // A terminal that arrives after a cancel is one the session already gave
      // a terminal for, and a second terminal for a finished turn would flip
      // it from cancelled to completed.
      const turnId = event.turnId ? this.nativeTurnIds.get(event.turnId) : this.activeTurnId;
      if (!turnId) return;
      if (this.terminalTurns.has(turnId)) return;
      this.terminalTurns.add(turnId);
      if (event.turnId) this.nativeTurnIds.delete(event.turnId);
      for (const [key, value] of this.turns) {
        if (value.turnId === turnId) this.turns.delete(key);
      }
      this.phase = this.turns.size > 0 ? "running" : "idle";
      if (this.activeTurnId === turnId) this.activeTurnId = undefined;
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId,
        state: event.type === "turn.completed" ? "completed" : "failed",
      });
    }
  }

  async close(): Promise<void> {
    this.unsubscribe();
    // The transport is shared by every session on this connection, so the
    // connection closes it, not the session.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/zcode-provider/server/internal/session.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/zcode-provider/server/internal/session.ts plugins/zcode-provider/server/internal/session.test.ts
git commit -m "feat(plugins): own the ZCode stop boundary in the session

A cancel that has not settled must not be followed by a new run, a
second interrupt must retry the cancel already in flight rather than
open a second one, and a cancel that failed must keep refusing new
runs."
```

---

### Task 8: Timeline and permission mapping

**Files:**

- Create: `plugins/zcode-provider/server/internal/timeline.ts`
- Create: `plugins/zcode-provider/server/internal/signals.ts`
- Test: `plugins/zcode-provider/server/internal/timeline.test.ts`
- Test: `plugins/zcode-provider/server/internal/signals.test.ts`

**Interfaces:**

- Consumes: `ZCodeEvent` from Task 6.
- Produces:
  - `mapEventToTimelineItems(event: ZCodeEvent, options?: TimelineMappingOptions): ProviderTimelineItem[]`
  - `toolDetailFor(input: unknown): ProviderToolCallDetail`
  - `TimelineMappingOptions` with an optional `toolDetails` map, so a tool call's detail survives from the `scheduled` variant to the later ones
  - `mapPermissionRequest(payload: unknown): ProviderPermissionRequest`
  - `permissionResponseFor(request: ProviderPermissionRequest, response: ProviderPermissionResponse): Record<string, JsonValue>`

- [ ] **Step 1: Write the failing tests**

Create `plugins/zcode-provider/server/internal/timeline.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { mapEventToTimelineItems } from "./timeline.js";

describe("ZCode timeline mapping", () => {
  test("maps an assistant message", () => {
    const items = mapEventToTimelineItems({
      type: "message.upserted",
      sessionId: "s1",
      seq: 1,
      payload: { content: "hello" },
    });
    expect(items).toEqual([{ id: "s1-1", type: "assistant_message", text: "hello" }]);
  });

  test("maps a reasoning delta", () => {
    const items = mapEventToTimelineItems({
      type: "part.delta",
      sessionId: "s1",
      seq: 2,
      payload: { messageId: "m2", partId: "p2", field: "reasoning", delta: "thinking" },
    });
    expect(items[0]).toMatchObject({ type: "reasoning", text: "thinking" });
  });

  test("maps a scheduled tool call", () => {
    const items = mapEventToTimelineItems({
      type: "tool.updated",
      sessionId: "s1",
      seq: 3,
      payload: {
        toolCallId: "t1",
        toolName: "read_file",
        kind: "scheduled",
        input: { path: "/a" },
      },
    });
    expect(items[0]).toMatchObject({
      type: "tool_call",
      callId: "t1",
      name: "read_file",
      status: "running",
      error: null,
      detail: { type: "read", filePath: "/a" },
    });
  });

  test("maps a completed tool call and keeps the detail from the scheduled event", () => {
    const toolDetails = new Map([["t1", { type: "read", filePath: "/a" } as const]]);
    const items = mapEventToTimelineItems(
      {
        type: "tool.updated",
        sessionId: "s1",
        seq: 4,
        payload: { toolCallId: "t1", toolName: "read_file", kind: "result" },
      },
      { toolDetails },
    );
    expect(items[0]).toMatchObject({
      type: "tool_call",
      callId: "t1",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: "/a" },
    });
  });

  test("maps a failed tool call", () => {
    const items = mapEventToTimelineItems({
      type: "tool.updated",
      sessionId: "s1",
      seq: 5,
      payload: {
        toolCallId: "t2",
        toolName: "bash",
        kind: "error",
        error: { message: "boom" },
      },
    });
    expect(items[0]).toMatchObject({
      type: "tool_call",
      callId: "t2",
      status: "failed",
      error: { message: "boom" },
    });
  });

  test("returns nothing for an event it does not map", () => {
    expect(
      mapEventToTimelineItems({
        type: "session.updated",
        sessionId: "s1",
        seq: 4,
        payload: {},
      }),
    ).toEqual([]);
  });
});
```

ZCode's legacy session snapshot carries the session's `settings`, and the catalog is read from them: the models come from `settings.model.available`, the thought levels from `settings.thoughtLevel.available`, and the current mode from `settings.mode.current`. The flat `configOptions` array is the v4 workspace-config projection of those same settings, and the legacy path never sends it.

ZCode's `tool.updated` payload is a discriminated union on `kind`, not a payload with a `status` field (`packages/shared/src/zcode-protocol/index.ts:1682-1741` in the ZCode repository). The variants are `scheduled`, `started`, `progress`, `result`, `error`, `batch` and `raw`. Only `scheduled` carries the tool call's `input`, so the detail has to survive from that event to the later ones: the session keeps it per tool call id and passes it to the mapper.

ZCode's `message.upserted` payload carries the content and nothing else (`packages/shared/src/zcode-protocol/index.ts:1631-1639`): no message id and no role. The timeline id comes from the event, and a user message cannot be told apart from an assistant one there.

Create `plugins/zcode-provider/server/internal/signals.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { mapPermissionRequest, permissionResponseFor } from "./signals.js";

describe("ZCode permission mapping", () => {
  const payload = {
    requestId: "p1",
    sessionId: "s1",
    toolCallId: "t1",
    toolName: "bash",
    reason: "run a command",
    riskLevel: "medium",
    input: { command: "ls" },
    options: [
      {
        optionId: "allow-once",
        kind: "allow",
        name: "Allow once",
        response: { decision: "allow" },
      },
      {
        optionId: "always",
        kind: "allow",
        name: "Always allow",
        response: {
          decision: "allow",
          permissionUpdates: { addRules: [{ behavior: "allow", toolName: "bash" }] },
        },
      },
      {
        optionId: "deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny", reason: "not allowed" },
      },
    ],
  };

  test("maps the options to permission actions", () => {
    const request = mapPermissionRequest(payload);
    expect(request.id).toBe("p1");
    expect(request.name).toBe("bash");
    expect(request.kind).toBe("tool");
    expect(request.actions?.map((action) => action.id)).toEqual(["allow-once", "always", "deny"]);
    expect(request.actions?.map((action) => action.behavior)).toEqual(["allow", "allow", "deny"]);
  });

  test("returns the selected option's ZCode response unchanged", () => {
    const request = mapPermissionRequest(payload);
    expect(
      permissionResponseFor(request, { behavior: "allow", selectedActionId: "always" }),
    ).toEqual({
      decision: "allow",
      permissionUpdates: { addRules: [{ behavior: "allow", toolName: "bash" }] },
    });
  });

  test("rejects an unknown action id", () => {
    const request = mapPermissionRequest(payload);
    expect(() =>
      permissionResponseFor(request, { behavior: "allow", selectedActionId: "nope" }),
    ).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/zcode-provider/server/internal/timeline.test.ts plugins/zcode-provider/server/internal/signals.test.ts --bail=1`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the timeline mapper**

Create `plugins/zcode-provider/server/internal/timeline.ts`:

```ts
import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { ZCodeEvent } from "./transport.js";

interface EventPayload {
  messageId?: string;
  partId?: string;
  field?: string;
  delta?: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  kind?: string;
  input?: unknown;
  error?: { message?: string };
}

export interface TimelineMappingOptions {
  /**
   * The detail of each tool call, keyed by tool call id. ZCode carries a
   * tool call's input only on the `scheduled` variant, so the detail has to
   * survive from that event to the `result` and `error` variants.
   */
  toolDetails?: ReadonlyMap<string, ProviderToolCallDetail>;
}

export function mapEventToTimelineItems(
  event: ZCodeEvent,
  options: TimelineMappingOptions = {},
): ProviderTimelineItem[] {
  const payload = (event.payload ?? {}) as EventPayload;
  if (event.type === "message.upserted") {
    // ZCode's message payload carries the content and nothing else: no
    // message id and no role. The id comes from the event, and a user
    // message cannot be told apart from an assistant one here.
    const id = `${event.sessionId}-${event.seq}`;
    return [{ id, type: "assistant_message", text: payload.content ?? "" }];
  }
  if (event.type === "part.delta") {
    const id = payload.partId ?? payload.messageId ?? `${event.sessionId}-${event.seq}`;
    const text = payload.delta ?? "";
    if (payload.field === "reasoning") return [{ id, type: "reasoning", text }];
    return [{ id, type: "assistant_message", text }];
  }
  if (event.type === "tool.updated") {
    const callId = payload.toolCallId ?? `${event.sessionId}-${event.seq}`;
    const name = payload.toolName ?? "tool";
    const detail = options.toolDetails?.get(callId) ??
      (payload.kind === "scheduled" ? toolDetailFor(payload.input) : undefined) ?? {
        type: "plain_text",
        label: name,
        text: "",
      };
    // A tool call is a discriminated union: `error` is null for every status
    // except `failed`. Compute the status and the error together, or the
    // object literal satisfies neither branch.
    if (payload.kind === "error") {
      return [
        {
          id: callId,
          type: "tool_call",
          callId,
          name,
          status: "failed",
          error: { message: payload.error?.message ?? "tool failed" },
          detail,
        },
      ];
    }
    const status = payload.kind === "result" ? "completed" : "running";
    return [{ id: callId, type: "tool_call", callId, name, status, error: null, detail }];
  }
  return [];
}

/**
 * ZCode reports a tool call as a name and an opaque input object. Pick the
 * detail variant that matches the input, so the client renders a file read
 * as a file read instead of a shell command.
 */
export function toolDetailFor(input: unknown): ProviderToolCallDetail {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const command = record.command;
  if (typeof command === "string") return { type: "shell", command };
  const filePath = record.filePath ?? record.path;
  if (typeof filePath === "string") return { type: "read", filePath };
  const query = record.query;
  if (typeof query === "string") return { type: "search", query };
  return { type: "shell", command: "" };
}
```

The session gains the tool-detail map and the import, because the timeline mapper lives in this task:

```ts
// In ZCodeSession, in plugins/zcode-provider/server/internal/session.ts:
import type {
  ProviderEvent,
  ProviderPrompt,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { toolDetailFor } from "./timeline.js";

/** The detail of each tool call, keyed by tool call id. */
private readonly toolDetails = new Map<string, ProviderToolCallDetail>();
```

- [ ] **Step 4: Write the permission mapper**

Create `plugins/zcode-provider/server/internal/signals.ts`:

```ts
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";

interface ZCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: Record<string, JsonValue>;
}

const ZCODE_OPTIONS_METADATA_KEY = "zcodePermissionOptions";

export function mapPermissionRequest(payload: unknown): ProviderPermissionRequest {
  const request = payload as {
    requestId?: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    reason: string;
    riskLevel: string;
    input: unknown;
    options: ZCodePermissionOption[];
  };
  return {
    // ZCode's permission request carries an optional request id. The tool
    // call id is always there and identifies the request just as well.
    id: request.requestId ?? request.toolCallId,
    name: request.toolName,
    kind: "tool",
    title: request.toolName,
    description: request.reason,
    input:
      request.input && typeof request.input === "object"
        ? (request.input as Record<string, JsonValue>)
        : undefined,
    actions: request.options.map((option) => ({
      id: option.optionId,
      label: option.name,
      behavior: option.response.decision === "allow" ? "allow" : "deny",
    })),
    metadata: {
      [ZCODE_OPTIONS_METADATA_KEY]: request.options as unknown as JsonValue,
    },
  };
}

export function permissionResponseFor(
  request: ProviderPermissionRequest,
  response: ProviderPermissionResponse,
): Record<string, JsonValue> {
  const actionId = "selectedActionId" in response ? response.selectedActionId : undefined;
  if (!actionId) {
    throw new Error("The permission response must name the action the user chose");
  }
  const options = request.metadata?.[ZCODE_OPTIONS_METADATA_KEY];
  const list = Array.isArray(options) ? (options as unknown as ZCodePermissionOption[]) : [];
  const chosen = list.find((option) => option.optionId === actionId);
  if (!chosen) throw new Error(`Unknown permission action: ${actionId}`);
  return chosen.response;
}
```

The raw ZCode options travel in `metadata`, which is a `Record<string, JsonValue>` on the request. That keeps the SDK type intact and means the selected action's own `response` reaches ZCode unchanged, including any `permissionUpdates` that make "always allow" stick.

The permission is not answered with a separate RPC. ZCode asks the host with a reverse request, `interaction/requestPermission`, and waits for that request's own response (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts:105-135` in the ZCode repository). There is no `interaction/respond` method in the legacy method table, so the answer travels back as the response to the reverse request.

The transport therefore exposes the reverse request instead of an answering method:

```ts
// In ZCodeTransport:
onRequest(listener: (request: ZCodeRequestFrame) => Promise<unknown> | unknown): () => void;

// In the legacy transport:
onRequest(listener) {
  return process.rpc.onRequest(listener);
},
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run plugins/zcode-provider/server/internal/timeline.test.ts plugins/zcode-provider/server/internal/signals.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/zcode-provider/server/internal/timeline.ts plugins/zcode-provider/server/internal/timeline.test.ts plugins/zcode-provider/server/internal/signals.ts plugins/zcode-provider/server/internal/signals.test.ts
git commit -m "feat(plugins): map ZCode events to timeline items and permissions"
```

---

### Task 9: Wire the provider connection

**Files:**

- Modify: `plugins/zcode-provider/server/provider.ts` — replace the stub with a real connection
- Modify: `plugins/zcode-provider/server/internal/catalog.ts`
- Test: `plugins/zcode-provider/server/internal/catalog.test.ts`
- Test: `plugins/zcode-provider/server/provider.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2, 6, 7, 8.
- Produces: `createZCodeProvider()` returning a working `ProviderRegistration`.

- [ ] **Step 1: Write the failing catalog test**

Create `plugins/zcode-provider/server/internal/catalog.test.ts`. The mapper lives in the catalog module Task 6 created; this task adds the mapper function and its test.

```ts
import { describe, expect, test } from "vitest";
import { mapCatalog } from "./catalog.js";

describe("ZCode catalog mapping", () => {
  test("maps models, modes and thought levels from the session settings", () => {
    const catalog = mapCatalog({
      settings: {
        model: {
          current: { providerId: "zai", modelId: "glm-5" },
          available: [
            { ref: { providerId: "zai", modelId: "glm-5" }, label: "GLM 5" },
            { ref: { providerId: "zai", modelId: "glm-4" }, label: "GLM 4" },
          ],
        },
        mode: { current: "plan" },
        thoughtLevel: {
          enabled: true,
          current: "high",
          available: [{ value: "high", label: "High" }],
        },
      },
    });
    expect(catalog.models.map((model) => model.id)).toEqual(["zai/glm-5", "zai/glm-4"]);
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["build", "guarded", "plan", "yolo"]);
    expect(catalog.thinkingOptions?.map((option) => option.id)).toEqual(["high"]);
    expect(catalog.defaultModel).toBe("zai/glm-5");
    expect(catalog.defaultMode).toBe("plan");
    expect(catalog.defaultThinkingOption).toBe("high");
  });

  test("offers no thought levels when ZCode disabled them", () => {
    const catalog = mapCatalog({
      settings: { thoughtLevel: { enabled: false, available: [{ value: "high", label: "High" }] } },
    });
    expect(catalog.thinkingOptions).toEqual([]);
  });

  test("returns an empty catalog for a snapshot without settings", () => {
    expect(mapCatalog({}).models).toEqual([]);
    expect(mapCatalog({}).modes).toHaveLength(4);
  });
});
```

ZCode projects its model, mode and thought-level options from session settings and returns them on a session snapshot, as a flat array of config options discriminated by `category` (`packages/shared/src/zcode-task-types-core.ts:392-402` in the ZCode repository). Each option carries `currentValue` for the selected value and an `options` array of `{ value, name }` entries. There is no nested `configOptions.model` object.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/internal/catalog.test.ts --bail=1`
Expected: FAIL with "Cannot find module './catalog.js'".

- [ ] **Step 3: Write the catalog mapper**

Add the mapper to `plugins/zcode-provider/server/internal/catalog.ts`, the module Task 6 created for the snapshot's settings types:

```ts
import type { ProviderCatalog } from "@getpaseo/plugin/server/provider";

/**
 * ZCode's session settings, as they arrive on a session snapshot
 * (`packages/shared/src/zcode-protocol/index.ts:1250-1281` in the ZCode
 * repository). The legacy snapshot carries `settings`; the flat
 * `configOptions` array is the v4 workspace-config projection of those same
 * settings, and the app-server never sends it on this path.
 */
export interface ZCodeModelSelection {
  providerId: string;
  modelId: string;
}

export interface ZCodeModelOption {
  ref: ZCodeModelSelection;
  label: string;
  description?: string;
}

export interface ZCodeThoughtLevelOption {
  value: string;
  label: string;
  description?: string;
}

export interface ZCodeSessionSettings {
  model?: {
    current?: ZCodeModelSelection;
    available?: ZCodeModelOption[];
  };
  thoughtLevel?: {
    enabled?: boolean;
    current?: string;
    available?: ZCodeThoughtLevelOption[];
  };
  mode?: {
    current?: string;
  };
}

export interface ZCodeSnapshot {
  settings?: ZCodeSessionSettings;
}

/**
 * The modes ZCode offers, with the labels it uses
 * (`packages/shared/src/zcode-agent-model-state.ts:19-40` in the ZCode
 * repository). ZCode also accepts `edit`, which it keeps as a historical
 * value but hides from the menu, so it is not offered here.
 */
export const ZCODE_MODES = [
  { id: "build", label: "Ask before changes", description: "Ask before each file changes." },
  { id: "guarded", label: "Autonomous mode", description: "Ask when there's risk" },
  {
    id: "plan",
    label: "Plan mode",
    description: "Inspect the code and present a plan before editing.",
  },
  {
    id: "yolo",
    label: "Full access",
    description: "Edit and run commands with fewer confirmations.",
  },
] as const;

/**
 * The model id Paseo carries. ZCode's own picker value is
 * "providerId/modelId" (`packages/shared/src/model-selection.ts:34-40` in the
 * ZCode repository), and the transport turns it back into the pair that
 * `session/setModel` wants.
 */
export function pickerValue(selection: ZCodeModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

export function mapCatalog(snapshot: ZCodeSnapshot): ProviderCatalog {
  const settings = snapshot.settings;
  const models = (settings?.model?.available ?? []).map((option) => ({
    id: pickerValue(option.ref),
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
  const thinkingOptions =
    settings?.thoughtLevel?.enabled === false
      ? []
      : (settings?.thoughtLevel?.available ?? []).map((option) => ({
          id: option.value,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        }));
  const defaultModel = settings?.model?.current ? pickerValue(settings.model.current) : undefined;
  const defaultMode = settings?.mode?.current;
  const defaultThinkingOption = settings?.thoughtLevel?.current;

  return {
    models,
    modes: ZCODE_MODES.map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
    })),
    thinkingOptions,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultMode ? { defaultMode } : {}),
    ...(defaultThinkingOption ? { defaultThinkingOption } : {}),
  };
}
```

- [ ] **Step 4: Write the connection**

Replace the stub `createConnection` in `plugins/zcode-provider/server/provider.ts` with this. It follows the `plugins/antigravity-provider/server/provider.ts` shape: a session map, a listener set, a serialized send queue, and a `dispatch` switch over `ProviderInput`.

The connection needs these imports on top of the ones the stub already has:

```ts
import type {
  ProviderCatalog,
  ProviderConnection,
  ProviderEvent,
  ProviderLaunch,
  ProviderPermissionRequest,
} from "@getpaseo/plugin/server/provider";
import { mapCatalog } from "./internal/catalog.js";
import { mapPermissionRequest, permissionResponseFor } from "./internal/signals.js";
```

```ts
function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, ZCodeSession>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  let pending = Promise.resolve();
  let transport: ZCodeTransport | undefined;

  /**
   * ZCode asks the host for permission with a reverse request and waits for
   * that request's answer. The answer has to come from the user, so the
   * request is held here until the daemon sends the user's decision back.
   */
  const pendingPermissions = new Map<
    string,
    { request: ProviderPermissionRequest; resolve: (value: unknown) => void }
  >();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function session(id: string): ZCodeSession {
    const found = sessions.get(id);
    if (!found) throw new ZCodeError(`Unknown ZCode session: ${id}`);
    return found;
  }

  /**
   * Paseo and ZCode name sessions differently. The persistence handle carries
   * the ZCode id, and the archive and unarchive inputs carry only that handle,
   * so the connection indexes both directions. The index outlives a closed
   * session, because an agent is closed before it is archived.
   */
  const nativeIndex = new Map<string, string>();

  function paseoIdForNative(nativeId: string): string {
    const paseoId = nativeIndex.get(nativeId);
    if (!paseoId) throw new ZCodeError(`Unknown ZCode session: ${nativeId}`);
    return paseoId;
  }

  function ensureTransport(): ZCodeTransport {
    if (!transport) {
      transport = createLegacyTransport(
        startZCodeProcess({ command: launch.command, args: launch.args, env: launch.env }),
      );
      transport.onRequest(async (request) => {
        if (request.method !== "interaction/requestPermission") {
          throw new Error(`Unsupported ZCode request: ${request.method}`);
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        const permission = mapPermissionRequest(params);
        const nativeSessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        const answer = new Promise<unknown>((resolve) => {
          pendingPermissions.set(permission.id, { request: permission, resolve });
        });
        emit({
          type: "session.permission",
          sessionId: nativeIndex.get(nativeSessionId) ?? nativeSessionId,
          request: permission,
        });
        return answer;
      });
    }
    return transport;
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog": {
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: await readCatalog(input.cwd),
        });
        return;
      }
      case "sessions": {
        const list = await ensureTransport().listSessions({
          ...(input.cwd
            ? { workspace: { workspacePath: input.cwd, workspaceKey: input.cwd } }
            : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        });
        emit({
          type: "sessions",
          requestId: input.requestId,
          sessions: list.map((entry) => toSessionSummary(entry)),
        });
        return;
      }
      case "session.open": {
        if (sessions.has(input.sessionId)) {
          throw new ZCodeError(`Session already exists: ${input.sessionId}`);
        }
        const opened = new ZCodeSession({
          id: input.sessionId,
          transport: ensureTransport(),
          emit,
        });
        sessions.set(input.sessionId, opened);
        try {
          const native = input.persistence
            ? await opened.resume({
                cwd: input.config.cwd,
                nativeSessionId: nativeSessionIdOf(input.persistence),
                replay: input.history === "replay",
              })
            : await opened.open({ cwd: input.config.cwd });
          nativeIndex.set(native, input.sessionId);
        } catch (error) {
          sessions.delete(input.sessionId);
          throw error;
        }
        return;
      }
      case "session.prompt": {
        await session(input.sessionId).prompt(input.prompt);
        return;
      }
      case "session.configure": {
        await session(input.sessionId).configure(input.changes);
        return;
      }
      case "session.interrupt": {
        await session(input.sessionId).interrupt();
        return;
      }
      case "session.permission": {
        const pending = pendingPermissions.get(input.permissionId);
        if (!pending) throw new ZCodeError(`Unknown permission request: ${input.permissionId}`);
        pendingPermissions.delete(input.permissionId);
        pending.resolve(permissionResponseFor(pending.request, input.response));
        emit({
          type: "session.permission_resolved",
          sessionId: input.sessionId,
          permissionId: input.permissionId,
        });
        return;
      }
      case "session.archive": {
        const nativeId = nativeSessionIdOf(input.persistence);
        await ensureTransport().archive({ sessionId: nativeId });
        emit({
          type: "session.persistence",
          sessionId: paseoIdForNative(nativeId),
          persistence: input.persistence,
        });
        return;
      }
      case "session.unarchive": {
        const nativeId = nativeSessionIdOf(input.persistence);
        await ensureTransport().resumeSession({ sessionId: nativeId });
        return;
      }
      case "session.can_stop_runtime": {
        // The daemon already refuses the probe while a turn is active or a
        // prompt is pending. The legacy transport has no background work of
        // its own: it runs no subagents and no background commands, so
        // releasing the runtime loses nothing.
        emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: true,
        });
        return;
      }
      case "session.close": {
        await session(input.sessionId).close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        return;
      }
      default:
        throw new ZCodeError(`Unsupported ZCode operation: ${input.type}`);
    }
  }

  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ZCodeError ? error.code : "ZCODE_ERROR";
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message, code } },
      });
      return;
    }
    if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: { message, code } });
    }
  }

  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new ZCodeError("ZCode connection is closed");
      requireProviderCapabilities(negotiated, input);
      pending = pending
        .then(async () => {
          if (!closed) await dispatch(input);
          return undefined;
        })
        .catch((error) => failed(input, error));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await Promise.all([...sessions.values()].map((opened) => opened.close()));
      sessions.clear();
      listeners.clear();
      await transport?.close();
      await child?.exit();
    },
  };
}
```

The registration also gains a catalog cache key. The legacy catalog comes from a ZCode session, and building it means opening one, so the daemon has to cache it:

```ts
async getCatalogCacheKey(options) {
  const launch = options.launch;
  if (!launch) return undefined;
  // The catalog depends on the executable and on the workspace whose settings
  // ZCode projects the options from.
  return `${launch.command}\u0000${options.cwd ?? ""}`;
}
```

The `connect` implementation becomes:

```ts
async connect(request) {
  if (!request.versions.includes(1)) {
    throw new ZCodeError("Provider protocol version 1 is required");
  }
  if (!request.launch) {
    throw new ZCodeError("The daemon must supply the ZCode launch");
  }
  const negotiated = negotiateProviderCapabilities(request.capabilities, ZCODE_CAPABILITIES);
  return createConnection(request.launch, negotiated);
}
```

`ZCodeSession` grows the three methods the dispatch calls, in `plugins/zcode-provider/server/internal/session.ts`:

```ts
async resume(input: {
  cwd: string;
  nativeSessionId: string;
  replay: boolean;
}): Promise<string> {
  const handle = await this.options.transport.resumeSession({
    sessionId: input.nativeSessionId,
    workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
  });
  this.nativeSessionId = handle.sessionId;
  this.options.emit({
    type: "session.opened",
    sessionId: this.options.id,
    capabilities: this.options.transport.capabilities,
    restoration: "core",
    cwd: input.cwd,
    persistence: { version: 1, data: { nativeSessionId: handle.sessionId } },
  });
  this.options.emit({ type: "session.ready", sessionId: this.options.id });
  return handle.sessionId;
}

async configure(changes: ProviderConfigChanges): Promise<void> {
  if (changes.model) await this.options.transport.setModel({ sessionId: this.nativeSessionId, model: changes.model });
  if (changes.mode) await this.options.transport.setMode({ sessionId: this.nativeSessionId, mode: changes.mode });
  if (changes.thinkingOption) {
    await this.options.transport.setThoughtLevel({
      sessionId: this.nativeSessionId,
      thoughtLevel: changes.thinkingOption,
    });
  }
}

async archive(): Promise<void> {
  await this.options.transport.archive({ sessionId: this.nativeSessionId });
}
```

Archive and unarchive are not session-scoped operations. The daemon restores an archived agent by calling `unarchiveNativeSession` _before_ it opens the session, so no live `ZCodeSession` exists at that moment. The connection therefore drives the transport directly with the ZCode id carried by the persistence handle, and never looks up a live session for either case.

The permission round trip belongs to the connection, not to the session. ZCode asks the host with a reverse request and waits for that request's answer; the `permission.requested` session event is the record of the same thing, and answering it does not release ZCode. The session therefore does not handle `permission.requested` at all, and the connection owns the round trip.

`archive` and `readSnapshot` are added to `ZCodeTransport` and to the legacy transport:

```ts
// In ZCodeTransport:
archive(input: { sessionId: string }): Promise<void>;
readSnapshot(input: { sessionId: string }): Promise<{ settings?: ZCodeSessionSettings }>;

// In the legacy transport:
async archive(input) {
  await process.rpc.call("session/close", { sessionId: input.sessionId });
},
async readSnapshot(input) {
  const snapshot = (await process.rpc.call("session/read", {
    sessionId: input.sessionId,
  })) as { settings?: ZCodeSessionSettings };
  return { settings: snapshot?.settings };
},
```

`session/read` requires a `sessionId`, and ZCode returns its config options on a session snapshot. The catalog is therefore read through a session the provider opens for the request:

```ts
/**
 * ZCode projects its model, mode and thought-level options from session
 * settings and returns them on a session snapshot. `session/read` requires a
 * session id, so the provider opens a session for the request, reads the
 * snapshot, and closes the session again.
 */
async function readCatalog(cwd: string | undefined): Promise<ProviderCatalog> {
  const workspacePath = cwd ?? process.cwd();
  const handle = await ensureTransport().createSession({
    workspace: { workspacePath, workspaceKey: workspacePath },
  });
  try {
    const snapshot = await ensureTransport().readSnapshot({ sessionId: handle.sessionId });
    return mapCatalog(snapshot);
  } finally {
    await ensureTransport().archive({ sessionId: handle.sessionId });
  }
}
```

The `catalog` input becomes:

```ts
case "catalog": {
  emit({
    type: "catalog",
    requestId: input.requestId,
    catalog: await readCatalog(input.cwd),
  });
  return;
}
```

`toSessionSummary` converts a ZCode session entry into a `ProviderSessionSummary`, which is `{ persistence, cwd, title?, description?, updatedAt? }`. ZCode's session info nests the workspace as `{ workspacePath, workspaceKey }` and reports `updatedAt` as a millisecond number (`packages/shared/src/zcode-protocol-legacy-types.ts:148-164` in the ZCode repository), so the summary has to read the nested path and render the timestamp as a string:

```ts
function nativeSessionIdOf(persistence: ProviderPersistence): string {
  const data = persistence.data as { nativeSessionId?: string };
  if (!data?.nativeSessionId) {
    throw new ZCodeError("The persistence handle carries no ZCode session id");
  }
  return data.nativeSessionId;
}

function toSessionSummary(entry: unknown): ProviderSessionSummary {
  // ZCode's session info nests the workspace and reports the update time as
  // a millisecond timestamp, while Paseo's summary wants a path and a string.
  const record = entry as {
    sessionId?: string;
    title?: string;
    workspace?: { workspacePath?: string; workspaceKey?: string };
    updatedAt?: number;
  };
  return {
    persistence: {
      version: 1,
      data: { nativeSessionId: record.sessionId ?? "" },
    },
    cwd: record.workspace?.workspacePath ?? "",
    ...(record.title ? { title: record.title } : {}),
    ...(record.updatedAt ? { updatedAt: new Date(record.updatedAt).toISOString() } : {}),
  };
}
```

**Process death.** When the child exits, every session it hosted reports the failure and closes. Add this to the connection, right after `ensureTransport` is defined:

```ts
function onProcessExit(error: Error): void {
  for (const opened of sessions.values()) {
    emit({
      type: "session.runtime_failed",
      sessionId: opened.id,
      error: { message: error.message, code: "ZCODE_EXITED" },
    });
    emit({ type: "session.closed", sessionId: opened.id, error: { message: error.message } });
  }
  sessions.clear();
}
```

`ZCodeProcess` exposes the failure through its `ready` promise, which rejects when the child exits. The connection awaits it once and calls `onProcessExit`:

```ts
void ensureTransportProcess().ready.catch((error) => {
  onProcessExit(error instanceof Error ? error : new Error(String(error)));
});
```

`ensureTransport` therefore keeps the `ZCodeProcess` next to the transport, not just the transport. Replace the earlier `ensureTransport` with this pair:

```ts
let child: ZCodeProcess | undefined;

/**
 * The bundled JavaScript runtime is an Electron app bundle. It only runs as
 * Node when ELECTRON_RUN_AS_NODE is set, and only the bundled runtime needs
 * it. The check reads the launch the daemon handed us, not the resolution
 * the plugin proposed, because a user override can replace the command.
 */
function childEnv(): Record<string, string> {
  const env = { ...launch.env };
  if (launch.args[0]?.endsWith(".cjs")) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function ensureTransportProcess(): ZCodeProcess {
  if (!child) {
    child = startZCodeProcess({ command: launch.command, args: launch.args, env: childEnv() });
    transport = createLegacyTransport(child);
  }
  return child;
}

function ensureTransport(): ZCodeTransport {
  ensureTransportProcess();
  return transport!;
}
```

- [ ] **Step 5: Write the provider test**

Create `plugins/zcode-provider/server/provider.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createZCodeProvider } from "./provider.js";

const fakeServer = fileURLToPath(new URL("../test/fake-zcode-app-server.mjs", import.meta.url));

describe("ZCode provider", () => {
  test("negotiates capabilities and does not advertise rewind", async () => {
    const provider = createZCodeProvider();
    const connection = await provider.connect({
      launch: {
        command: process.execPath,
        args: [fakeServer],
        env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
      },
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    expect(connection.capabilities).toContain("prompt.message");
    expect(connection.capabilities).not.toContain("session.revert.conversation");
    await connection.close();
  });

  test("opens a session and reports it ready", async () => {
    const provider = createZCodeProvider();
    const connection = await provider.connect({
      launch: {
        command: process.execPath,
        args: [fakeServer],
        env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
      },
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "p1",
      config: {
        cwd: "/tmp",
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session.ready")).toBe(true);
    });
    await connection.close();
  });

  test("answers the permission ZCode asks for with a reverse request", async () => {
    const provider = createZCodeProvider();
    const connection = await provider.connect({
      launch: {
        command: process.execPath,
        args: [fakeServer],
        env: { ...process.env, FAKE_ZCODE_MODE: "permission" },
      },
      versions: [1],
      capabilities: ["prompt.message", "permission"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "p1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    } as ProviderInput);
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session.ready")).toBe(true);
    });

    // The fake app-server sends the permission as a reverse request and waits
    // for the answer on that request.
    await connection.send({
      type: "session.prompt",
      sessionId: "p1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    } as ProviderInput);

    await vi.waitFor(() => {
      const permission = events.find((event) => event.type === "session.permission");
      expect(permission).toBeDefined();
    });
    const permission = events.find((event) => event.type === "session.permission") as
      | Extract<ProviderEvent, { type: "session.permission" }>
      | undefined;
    expect(permission?.request.actions.map((action) => action.id)).toEqual(["allow", "deny"]);

    await connection.send({
      type: "session.permission",
      sessionId: "p1",
      permissionId: permission!.request.id,
      response: { behavior: "allow", selectedActionId: "allow" },
    } as ProviderInput);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session.permission_resolved")).toBe(true);
    });
    await connection.close();
  });
});
```

The fake app-server has to send the permission as a reverse request — a frame with an `id` and a `method` — and wait for that frame's answer. It is the answer to that request that releases ZCode, so the fake cannot move on until it receives one.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run plugins/zcode-provider/server/internal/catalog.test.ts plugins/zcode-provider/server/provider.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, format**

Run: `npm run typecheck && npm run lint && npm run format:files -- plugins/zcode-provider`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add plugins/zcode-provider
git commit -m "feat(plugins): wire the ZCode provider connection"
```

---

### Task 10: End-to-end test against the fake app-server

**Files:**

- Modify: `plugins/zcode-provider/test/fake-zcode-app-server.mjs`
- Create: `plugins/zcode-provider/server/provider.e2e.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2 through 9.
- Produces: a test that drives a real child process over the real protocol.

- [ ] **Step 1: Extend the fake app-server**

Replace `plugins/zcode-provider/test/fake-zcode-app-server.mjs` with a version that scripts a full turn. `session/create` returns a session id, `session/send` queues three events, and `session/events` returns the queued events the client has not seen yet, advancing by `seq`.

Two modes, chosen with `FAKE_ZCODE_MODE`: `ok` runs the turn straight, and `permission` asks the host for permission first. The loop must not wait inside it — the answer to the fake's own reverse request arrives as a later line, and a loop that awaited would never read it. The fake therefore remembers the pending turn and finishes it when the answer comes.

```js
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const mode = process.env.FAKE_ZCODE_MODE ?? "ok";
const queue = [];
let seq = 0;
/** The turn waiting on the host's answer to the fake's permission request. */
let pendingTurn = null;

function push(sessionId, type, payload, extra = {}) {
  seq += 1;
  queue.push({
    eventId: `e${seq}`,
    sessionId,
    turnId: extra.turnId,
    seq,
    timestamp: Date.now(),
    type,
    payload,
  });
}

function pushTurn(sessionId, inputId, content) {
  const turnId = "turn-1";
  push(sessionId, "turn.started", { turnNumber: 1, input: content, inputId }, { turnId });
  push(
    sessionId,
    "message.upserted",
    { messageId: "m1", role: "assistant", content: "hello from zcode" },
    { turnId },
  );
  push(
    sessionId,
    "turn.completed",
    { response: "hello from zcode", tokenCount: 12, toolCallCount: 0, duration: 5 },
    { turnId },
  );
}

for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const id = request.id;

  // The host's answer to the reverse request the fake sent. It arrives as a
  // frame with the fake's own id, and it is not a request from the host.
  if (id === "perm-1") {
    const turn = pendingTurn;
    pendingTurn = null;
    if (turn) {
      pushTurn(turn.sessionId, turn.inputId, turn.content);
      process.stdout.write(
        `${JSON.stringify({ id: turn.requestId, result: { sessionId: turn.sessionId, accepted: true, stateRevision: 1 } })}\n`,
      );
    }
    continue;
  }

  if (mode === "exit") {
    process.exit(3);
  }
  if (mode === "stderr") {
    process.stderr.write("ZCode runtime missing\n");
    process.exit(1);
  }

  if (request.method === "session/create") {
    process.stdout.write(`${JSON.stringify({ id, result: { sessionId: "zcode-1" } })}\n`);
    continue;
  }
  if (request.method === "session/send") {
    const sessionId = request.params.sessionId;
    const turnId = "zcode-turn-1";
    push(
      sessionId,
      "turn.started",
      { turnNumber: 1, input: request.params.content, inputId: request.params.inputId },
      { turnId },
    );
    push(
      sessionId,
      "message.upserted",
      { messageId: "m1", role: "assistant", content: "hello from zcode" },
      { turnId },
    );
    push(
      sessionId,
      "turn.completed",
      { response: "hello from zcode", tokenCount: 12, toolCallCount: 0, duration: 5 },
      { turnId },
    );
    process.stdout.write(
      `${JSON.stringify({ id, result: { sessionId, accepted: true, stateRevision: 1 } })}\n`,
    );
    continue;
  }
  if (request.method === "session/events") {
    const afterSeq = request.params.afterSeq ?? 0;
    const events = queue.filter((event) => event.seq > afterSeq);
    process.stdout.write(`${JSON.stringify({ id, result: { events } })}\n`);
    continue;
  }
  if (request.method === "runtime/capabilities") {
    process.stdout.write(`${JSON.stringify({ id, result: { ok: true } })}\n`);
    continue;
  }
  process.stdout.write(`${JSON.stringify({ id, result: {} })}\n`);
}
```

- [ ] **Step 2: Write the failing test**

Create `plugins/zcode-provider/server/provider.e2e.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createZCodeProvider } from "./provider.js";

const fakeServer = fileURLToPath(new URL("../test/fake-zcode-app-server.mjs", import.meta.url));

describe("ZCode provider end to end", () => {
  test("opens a session, streams a reply and completes the turn", async () => {
    const provider = createZCodeProvider();
    const connection = await provider.connect({
      launch: {
        command: process.execPath,
        args: [fakeServer],
        env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
      },
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "p1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    } as ProviderInput);
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session.ready")).toBe(true);
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "p1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    } as ProviderInput);

    await vi.waitFor(() => {
      expect(
        events.some(
          (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
        ),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        events.some((event) => event.type === "session.turn" && event.state === "completed"),
      ).toBe(true);
    });

    await connection.close();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run plugins/zcode-provider/server/provider.e2e.test.ts --bail=1`
Expected: FAIL until the fake app-server scripts the turn and the connection maps the events.

- [ ] **Step 4: Make it pass**

The session's event handler turns a ZCode event into timeline items and publishes them. Add this to `ZCodeSession.handleEvent`, before the turn handling:

```ts
if (
  event.type !== "turn.started" &&
  event.type !== "turn.completed" &&
  event.type !== "turn.failed"
) {
  if (event.type === "tool.updated") {
    const payload = event.payload as
      | { kind?: string; toolCallId?: string; input?: unknown }
      | undefined;
    // Only the scheduled variant carries the tool call's input. Remember it,
    // because the later result and error variants describe the same call and
    // the timeline item has to keep its detail.
    if (payload?.kind === "scheduled" && payload.toolCallId) {
      this.toolDetails.set(payload.toolCallId, toolDetailFor(payload.input));
    }
  }
  for (const item of mapEventToTimelineItems(event, { toolDetails: this.toolDetails })) {
    this.options.emit({ type: "timeline.item", sessionId: this.options.id, item });
  }
}
```

`turn.completed` carries `tokenCount`, which becomes usage. Add this branch to `handleEvent`, **before** the branch that handles `turn.completed` for the turn state, because that branch clears the native turn id this one reads:

```ts
if (event.type === "turn.completed") {
  const payload = event.payload as { tokenCount?: number } | undefined;
  const turnId =
    (event.turnId ? this.nativeTurnIds.get(event.turnId) : undefined) ?? this.activeTurnId;
  this.options.emit({
    type: "session.usage",
    sessionId: this.options.id,
    ...(turnId ? { turnId } : {}),
    usage: { inputTokens: payload?.tokenCount, outputTokens: 0 },
  });
}
```

The `timeline.item` event carries `item: ProviderTimelineItem`, and the assistant message comes from the `message.upserted` event the fake emits. The turn ends when `turn.completed` arrives, which the fake queues at the same `seq` order the transport reads.

- [ ] **Step 5: Run the full plugin test set**

Run: `npx vitest run plugins/zcode-provider --bail=1`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, format**

Run: `npm run typecheck && npm run lint && npm run format:files -- plugins/zcode-provider`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add plugins/zcode-provider
git commit -m "test(plugins): drive the ZCode provider against a real child process"
```

---

## Deferred: the V4 transport

The V4 transport is a separate plan and is deliberately not part of this one. It needs a grounding pass over ZCode's V4 wire format that this plan did not do, and guessing at it would produce a plan full of invented detail.

Its entry criteria are met once this plan lands:

- The `ZCodeTransport` interface in `plugins/zcode-provider/server/internal/transport.ts` is the seam the V4 transport implements. It already exists, so the V4 work does not touch the legacy transport, the session state machine, the timeline mapper, the permission mapper, or the connection wiring.
- The capability list changes in exactly one place. `ZCODE_CAPABILITIES` in `plugins/zcode-provider/server/capabilities.ts` gains `session.revert.conversation`, `session.revert.files`, `session.revert.both` and `prompt.steer`, and the transport's own `capabilities` becomes the authority so the two transports differ without touching the connection.
- `PASEO_ZCODE_PROTOCOL` selects the transport. It reads `auto`, `legacy` or `v4` from the environment, with `auto` meaning "use the V4 transport when the CLI reports support for it, otherwise the legacy transport".

The V4 plan has to cover: topic subscription and the snapshot-plus-delta read model, the sequence and log-epoch watermarks, gap detection and resync, the CAS command envelope and its `baseRevision`, the six acknowledgement states, `applyFileRewind` and `editUserQuery` for rewind, the queue commands for steer, and the transport selection probe.

Its acceptance gate is the same as the spec states: `auto` resolves to V4 only after the V4 transport passes the real-ZCode local end-to-end smoke test. Until then `auto` resolves to legacy.
