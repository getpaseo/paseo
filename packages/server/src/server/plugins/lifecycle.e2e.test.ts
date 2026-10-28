import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { BuiltinPluginLoader } from "./builtin/index.js";

test("a plugin transforms workspace creation once across receipt replays and observes its committed lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-lifecycle-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "lifecycle", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("workspace.create", ({ request }) => {
    console.log(JSON.stringify({ hook: "workspace.before" }));
    return { ...request, title: "Created through a hook" };
  });
  server.on("workspace.created", (event) => {
    console.log(JSON.stringify({ hook: "workspace.created", event }));
  });
  server.on("workspace.archived", (event) => {
    console.log(JSON.stringify({ hook: "workspace.archived", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const created = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(created.workspace?.name).toBe("Created through a hook");
    const workspaceId = created.workspace!.id;
    const replay = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(workspaceId);
    await client.archiveWorkspace(workspaceId);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        { hook: "workspace.before" },
        { hook: "workspace.created", event: { workspace: { id: workspaceId, cwd: directory } } },
        { hook: "workspace.archived", event: { workspace: { id: workspaceId } } },
      ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("addHook transforms workspace creation once across receipt replays and observes its committed lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-lifecycle-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "lifecycle", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.addHook("workspace.create.before", async ({ request }) => {
    console.log(JSON.stringify({ hook: "workspace.before" }));
    return { ...request, title: "Created through a hook" };
  });
  server.addHook("workspace.create.after", async (event) => {
    console.log(JSON.stringify({ hook: "workspace.create.after", event }));
  });
  server.addHook("workspace.archive.after", async (event) => {
    console.log(JSON.stringify({ hook: "workspace.archive.after", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const created = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(created.workspace?.name).toBe("Created through a hook");
    const workspaceId = created.workspace!.id;
    const replay = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(workspaceId);
    await client.archiveWorkspace(workspaceId);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        { hook: "workspace.before" },
        {
          hook: "workspace.create.after",
          event: { workspace: { id: workspaceId, cwd: directory } },
        },
        { hook: "workspace.archive.after", event: { workspace: { id: workspaceId } } },
      ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("plugins observe turns, answer permissions, and observe archive without blocking the agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "turn-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.addHook("agent.turn.before", async (event) => {
    console.log(JSON.stringify({ hook: "agent.turn.before", event }));
  });
  server.addHook("agent.turn.after", async (event) => {
    console.log(JSON.stringify({ hook: "agent.turn.after", event }));
  });
  server.addHook("agent.permission.before", async (event, context) => {
    console.log(JSON.stringify({ hook: "agent.permission.before", event }));
    await context.paseo.agents.ref(event.agent.id).respondToPermission({
      requestId: event.request.id,
      response: { behavior: "deny", message: "Declined by plugin" },
    });
  });
  server.addHook("agent.permission.after", async (event) => {
    console.log(JSON.stringify({ hook: "agent.permission.after", event }));
  });
  server.addHook("agent.archive.after", async (event) => {
    console.log(JSON.stringify({ hook: "agent.archive.after", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Turn hooks",
      modeId: "default",
    });
    await client.sendMessage(agent.id, "Run rm -f permission.txt");
    await expect
      .poll(
        async () => {
          const logs = await client.getPluginLogs("turn-hooks");
          return logs
            .filter((entry) => {
              return entry.message.startsWith('{"hook":');
            })
            .map((entry) => {
              return JSON.parse(entry.message);
            })
            .sort((left, right) => {
              return left.hook.localeCompare(right.hook);
            });
        },
        { timeout: 10_000 },
      )
      .toMatchObject([
        { hook: "agent.permission.after", event: { resolution: { behavior: "deny" } } },
        {
          hook: "agent.permission.before",
          event: { request: { input: { command: "rm -f permission.txt" } } },
        },
        {
          hook: "agent.turn.after",
          event: { outcome: { kind: "completed" }, timeline: [] },
        },
        { hook: "agent.turn.before", event: { agent: { id: agent.id } } },
      ]);
    const page = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 20 });
    expect(page.entries.length).toBeGreaterThan(0);
    await client.archiveAgent(agent.id);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("turn-hooks");
        return logs.filter((entry) => {
          return entry.message.startsWith('{"hook":"agent.archive.after"');
        }).length;
      })
      .toBe(1);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("agent creation hooks change the provider and environment before the session opens", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-hooks-"));
  const pluginDirectory = await createProviderPlugin(directory, {
    acknowledgeClose: true,
    hooks: `
  server.addHook("agent.create.before", async ({ request }) => {
    return { ...request, config: { ...request.config, provider: "${PROVIDER_ID}", model: "shutdown-model" }, env: { ...request.env, HOOK_CREATE: "created" } };
  });
  server.addHook("agent.open.before", async ({ request }) => {
    console.log(JSON.stringify({ hook: "agent.open.before", request }));
    return { ...request, env: { ...request.env, HOOK_OPEN: "opened" } };
  });
  server.addHook("agent.create.after", async (event) => {
    console.log(JSON.stringify({ hook: "agent.create.after", event }));
  });`,
    reportOpen: true,
  });
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Hook test",
    });
    expect(agent.provider).toBe(PROVIDER_ID);
    expect(await daemon.daemon.agentStorage.get(agent.id)).toMatchObject({
      provider: PROVIDER_ID,
      config: { model: "shutdown-model" },
    });
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("shutdown-provider-plugin");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        {
          hook: "agent.open.before",
          request: { agentId: agent.id, env: { HOOK_CREATE: "created" } },
        },
        {
          hook: "provider.open",
          config: { env: { HOOK_CREATE: "created", HOOK_OPEN: "opened" } },
        },
        {
          hook: "agent.create.after",
          event: { agent: { id: agent.id, provider: PROVIDER_ID } },
        },
      ]);
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("invalid output from an untyped plugin rejects creation before later callbacks run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-invalid-hook-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "invalid-hook", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.addHook("workspace.create.before", async () => {
    return { source: { kind: "worktree", branchName: 42 } };
  });
  server.addHook("workspace.create.before", async ({ request }) => {
    console.log("Unexpected later callback");
    return request;
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const result = await client.createWorkspace({ source: { kind: "directory", path: directory } });
    expect(result.workspace).toBeNull();
    expect(result.error).toContain("Plugin invalid-hook workspace.create.before failed");
    const logs = await client.getPluginLogs("invalid-hook");
    expect(
      logs.some((entry) => {
        return entry.message.includes("Unexpected later callback");
      }),
    ).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

const PROVIDER_ID = "shutdown-provider";

async function createProviderPlugin(
  root: string,
  options: { acknowledgeClose: boolean; hooks?: string; reportOpen?: boolean } = {
    acknowledgeClose: true,
  },
): Promise<string> {
  const directory = path.join(root, "plugin");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "shutdown-provider-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import type {
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

const CAPABILITIES = ["prompt.message", "session.persistence"];

const provider: ProviderRegistration = {
  id: ${JSON.stringify(PROVIDER_ID)},
  label: "Shutdown provider",
  async connect() {
    let listener: ((event: ProviderEvent) => void) | null = null;
    const emit = (event: ProviderEvent) => listener?.(event);
    let turn = 0;
    return {
      version: 1,
      capabilities: CAPABILITIES,
      async send(input: ProviderInput) {
        if (input.type === "catalog") {
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models: [{ id: "shutdown-model", label: "Shutdown model" }],
              modes: [],
              thinkingOptions: [],
              defaultModel: "shutdown-model",
            },
          });
          return;
        }
        if (input.type === "session.open") {
          if (${JSON.stringify(options.reportOpen ?? false)}) console.log(JSON.stringify({ hook: "provider.open", config: input.config }));
          emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities: CAPABILITIES,
            restoration: "core",
            persistence: { version: 1, data: { token: "root" } },
            cwd: input.config.cwd,
          });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          return;
        }
        if (input.type === "session.prompt") {
          turn += 1;
          const turnId = "turn-" + turn;
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "turn", turnId },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
          emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: { type: "assistant_message", id: "answer-" + turn, text: "Done" },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
          return;
        }
        if (input.type === "session.close") {
          if (!${JSON.stringify(options.acknowledgeClose)}) return;
          emit({ type: "session.closed", sessionId: input.sessionId });
        }
        if ("requestId" in input) {
          emit({ type: "request.completed", requestId: input.requestId });
        }
      },
      onEvent(next: (event: ProviderEvent) => void) {
        listener = next;
        return () => {
          if (listener === next) listener = null;
        };
      },
      async close() {},
    };
  },
};

export default function contribute(server: { registerProvider(p: ProviderRegistration): void }) {
  server.registerProvider(provider);
${options.hooks ?? ""}
  return () => undefined;
}`,
  );
  return directory;
}

test("a clean daemon shutdown leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-shutdown-"));
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pluginDirectory = await createProviderPlugin(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Shutdown provider agent",
  });
  await client.sendMessage(agent.id, "hello");
  const finished = await client.waitForFinish(agent.id, 30_000);
  expect(finished.status).toBe("idle");

  const beforeShutdown = await daemon.daemon.agentStorage.get(agent.id);
  expect(beforeShutdown?.lastError ?? null).toBeNull();

  await client.close();
  await daemon.daemon.stop();
  await daemon.daemon.agentStorage.flush().catch(() => undefined);

  const persisted = await daemon.daemon.agentStorage.get(agent.id);
  expect(persisted).not.toBeNull();
  expect(persisted?.lastError ?? null).toBeNull();
  expect(persisted?.attentionReason ?? null).not.toBe("error");
}, 60_000);

test("reloading a plugin leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-reload-"));
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pluginDirectory = await createProviderPlugin(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  onTestFinished(async () => {
    await client.close();
    await daemon.close();
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Reload provider agent",
  });
  await client.sendMessage(agent.id, "hello");
  expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");

  const reloaded = await client.reloadPlugin("shutdown-provider-plugin");
  expect(reloaded.status).toBe("running");

  const afterReload = await daemon.daemon.agentStorage.get(agent.id);
  expect(afterReload?.lastError ?? null).toBeNull();
  expect(afterReload?.attentionReason ?? null).not.toBe("error");
  const timeline = await client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(JSON.stringify(timeline.entries)).not.toContain("Provider connection closed");

  await client.sendMessage(agent.id, "after reload");
  expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");
}, 60_000);

test("a provider that never acknowledges session.close does not hold the daemon open", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-stuck-close-"));
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pluginDirectory = await createProviderPlugin(root, { acknowledgeClose: false });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Stuck close agent",
  });
  await client.sendMessage(agent.id, "hello");
  await client.waitForFinish(agent.id, 30_000);
  await client.close();

  // Without a deadline on each agent close, stop() never returns here and the
  // test fails by timing out.
  await expect(daemon.daemon.stop()).resolves.toBeUndefined();
}, 90_000);

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

// Hold the provider close until the subprocess has entered shutdown cleanup.
async function createSlowClosingProviderPlugin() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-slow-close-plugin-"));
  const closeStarted = path.join(directory, "close-started");
  const closeRelease = path.join(directory, "close-release");
  const cleanupStarted = path.join(directory, "cleanup-started");
  await cp(path.join(repoRoot, "plugin-examples/provider-direct"), directory, { recursive: true });
  const providerPath = path.join(directory, "server", "provider.ts");
  const source = (await readFile(providerPath, "utf8")).replaceAll("\r\n", "\n");
  const patched = `import { readFile, writeFile } from "node:fs/promises";\n${source.replace(
    "      closed = true;\n      sessions.clear();",
    `      closed = true;
      await writeFile(${JSON.stringify(closeStarted)}, "started");
      while (true) {
        try { await readFile(${JSON.stringify(closeRelease)}); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      sessions.clear();
      console.log("provider close completed");`,
  )}`;
  expect(patched).toContain(`await writeFile(${JSON.stringify(closeStarted)}, "started")`);
  await writeFile(providerPath, patched);
  const entryPath = path.join(directory, "index.server.ts");
  const entry = (await readFile(entryPath, "utf8")).replaceAll("\r\n", "\n");
  const withCleanup = `import { writeFile } from "node:fs/promises";\n${entry.replace(
    "  return () => {};",
    `  return async () => { await writeFile(${JSON.stringify(cleanupStarted)}, "started"); console.log("plugin cleanup completed"); };`,
  )}`;
  expect(withCleanup).toContain(`await writeFile(${JSON.stringify(cleanupStarted)}, "started")`);
  await writeFile(entryPath, withCleanup);
  return { directory, closeStarted, closeRelease, cleanupStarted };
}

test("reloading a plugin does not send on a closed IPC channel", async () => {
  const {
    directory: pluginDirectory,
    closeStarted,
    closeRelease,
    cleanupStarted,
  } = await createSlowClosingProviderPlugin();
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-reload-teardown-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const agent = await client.createAgent({ provider: "direct-example", cwd });
    const turn = client.sendMessage(agent.id, "Say hello").catch(() => undefined);
    const reload = client.reloadPlugin("provider-direct-example");
    await expect
      .poll(() => readFile(closeStarted, "utf8").catch(() => null), { timeout: 20_000 })
      .toBe("started");
    await expect
      .poll(() => readFile(cleanupStarted, "utf8").catch(() => null), { timeout: 20_000 })
      .toBe("started");
    await writeFile(closeRelease, "release");
    const reloaded = await reload;
    expect(reloaded.status).toBe("running");
    const entries = await client.getPluginLogs("provider-direct-example");
    const messages = entries.map((entry) => entry.message).join("\n");
    expect(messages).not.toContain("ERR_IPC_CHANNEL_CLOSED");
    expect(entries.filter((entry) => entry.message === "plugin cleanup completed")).toHaveLength(1);
    expect(entries.filter((entry) => entry.message === "provider close completed")).toHaveLength(1);
    await turn;
    await client.archiveAgent(agent.id).catch(() => undefined);
  } finally {
    await writeFile(closeRelease, "release");
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}, 60_000);

test("waiting hook failures reject the operation while notification failures are logged and later handlers run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-hook-failures-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "hook-failures",
        requirements: { paseo: ">=0.14.0-beta.1" },
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.addHook("workspace.create.before", async ({ request }) => {
    if (request.title === "reject") throw new Error("waiting hook rejected");
    return request;
  });
  server.addHook("workspace.create.after", async () => {
    throw new Error("notification rejected");
  });
  server.addHook("workspace.create.after", async ({ workspace }) => {
    console.log("Later notification for " + workspace.id);
  });
  return () => {};
}`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const failed = await client.createWorkspace({
      title: "reject",
      source: { kind: "directory", path: directory },
    });
    expect(failed.workspace).toBeNull();
    expect(failed.error).toContain(
      "Plugin hook-failures workspace.create.before failed: waiting hook rejected",
    );
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    expect(created.error).toBeNull();
    expect(created.workspace?.workspaceDirectory).toBe(directory);
    await expect
      .poll(async () =>
        (await client.getPluginLogs("hook-failures")).map(({ message }) => message).join("\n"),
      )
      .toContain("Later notification for " + created.workspace!.id);
    const messages = (await client.getPluginLogs("hook-failures"))
      .map(({ message }) => message)
      .join("\n");
    expect(messages).toContain("Lifecycle hook workspace.create.after failed");
    expect(messages).toContain("notification rejected");
    expect(messages).toContain("Later notification for " + created.workspace!.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test.each([false, true])(
  "worktree creation waits for plugins before its first agent and rolls back failures (firstAgentContext: %s)",
  async (withFirstAgentContext) => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-hook-"));
    const repository = path.join(root, "repository");
    execFileSync("git", ["init", "-b", "main", repository], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: repository, stdio: "pipe" },
    );
    execFileSync("git", ["checkout", "-b", "plugin-base"], { cwd: repository, stdio: "pipe" });
    await writeFile(path.join(repository, "from-plugin-base.txt"), "base");
    execFileSync("git", ["add", "."], { cwd: repository, stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "plugin base",
      ],
      { cwd: repository, stdio: "pipe" },
    );
    execFileSync("git", ["checkout", "main"], { cwd: repository, stdio: "pipe" });
    const orderFile = path.join(root, "order.jsonl");
    const pluginDirectory = await createProviderPlugin(root, {
      acknowledgeClose: true,
      hooks: `
  server.addHook("worktree.create.before", async ({ request }) => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(${JSON.stringify(orderFile)}, JSON.stringify({ hook: "worktree.create.before", request }) + "\\n");
    return { ...request, path: ${JSON.stringify(path.join(root, "elsewhere"))} + "/" + request.slug,
      branch: request.branch === "accept-hook" ? "plugin-branch" : request.branch,
      baseRef: request.branch === "accept-hook" ? "plugin-base" : request.baseRef };
  });
  server.addHook("worktree.create.after", async ({ worktree }) => {
    const { appendFile, writeFile } = await import("node:fs/promises");
    await appendFile(${JSON.stringify(orderFile)}, JSON.stringify({ hook: "worktree.create.after", worktree }) + "\\n");
    if (worktree.branch === "reject-hook") throw new Error("worktree rejected");
    await writeFile(worktree.path + "/plugin-ready.txt", "ready");
  });
  server.addHook("workspace.create.after", async () => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(${JSON.stringify(orderFile)}, JSON.stringify({ hook: "workspace.create.after" }) + "\\n");
  });
  server.addHook("agent.create.before", async ({ request }) => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(${JSON.stringify(orderFile)}, JSON.stringify({ hook: "agent.create.before" }) + "\\n");
    return request;
  });
  server.addHook("agent.open.before", async ({ request }) => {
    const { readFile } = await import("node:fs/promises");
    const contents = await readFile(request.cwd + "/plugin-ready.txt", "utf8");
    if (contents !== "ready") throw new Error("missing plugin output");
    console.log(JSON.stringify({ hook: "first-agent-ready", agentId: request.agentId, cwd: request.cwd, contents }));
    return request;
  });`,
    });
    let daemon = await createTestPaseoDaemon({
      paseoHomeRoot: path.join(root, "state"),
      cleanup: false,
    });
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      await client.patchDaemonConfig({ pluginsEnabled: true });
      const installed = await client.installDirectoryPlugin(pluginDirectory);
      expect(installed.status).toBe("running");
      const created = await client.createWorkspace({
        ...(withFirstAgentContext
          ? {
              firstAgentContext: { prompt: "Check the initialized worktree" },
              agent: {
                provider: PROVIDER_ID,
                cwd: repository,
                initialPrompt: "Check the initialized worktree",
              },
            }
          : {}),
        source: {
          kind: "worktree",
          cwd: repository,
          branchName: "accept-hook",
          worktreeSlug: "accept-hook",
        },
      });
      expect(created.error).toBeNull();
      const cwd = created.workspace!.workspaceDirectory;
      expect(created.workspace!.gitRuntime?.currentBranch).toBe("plugin-branch");
      const persisted = JSON.parse(
        await readFile(path.join(daemon.paseoHome, "projects", "workspaces.json"), "utf8"),
      );
      expect(persisted).toContainEqual(
        expect.objectContaining({
          workspaceId: created.workspace!.id,
          branch: "plugin-branch",
          baseBranch: "refs/heads/plugin-base",
          worktreeRoot: cwd,
        }),
      );
      expect(cwd).toBe(path.join(await realpath(root), "elsewhere", "accept-hook"));
      expect(await readFile(path.join(cwd, "from-plugin-base.txt"), "utf8")).toBe("base");
      expect(
        execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(),
      ).toBe("plugin-branch");
      expect(await readFile(path.join(cwd, "plugin-ready.txt"), "utf8")).toBe("ready");
      const firstAgent = withFirstAgentContext
        ? created.agent!
        : await client.createAgent({
            provider: PROVIDER_ID,
            cwd,
            workspaceId: created.workspace!.id,
          });
      expect(firstAgent).toMatchObject({
        cwd,
        workspaceId: created.workspace!.id,
        provider: PROVIDER_ID,
      });
      await expect
        .poll(async () =>
          (await client.getPluginLogs("shutdown-provider-plugin"))
            .filter(({ message }) => message.startsWith('{"hook":"first-agent-ready"'))
            .map(({ message }) => JSON.parse(message)),
        )
        .toContainEqual({
          hook: "first-agent-ready",
          agentId: firstAgent.id,
          cwd,
          contents: "ready",
        });
      const records = (await readFile(orderFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.hook)).toEqual([
        "worktree.create.before",
        "worktree.create.after",
        "workspace.create.after",
        "agent.create.before",
      ]);
      expect({
        ...records[1].worktree,
        sourceCheckout: await realpath(records[1].worktree.sourceCheckout),
      }).toEqual({
        path: cwd,
        branch: "plugin-branch",
        sourceCheckout: await realpath(repository),
      });
      expect((await client.fetchWorkspaces()).entries.map((workspace) => workspace.id)).toContain(
        created.workspace!.id,
      );
      await client.archiveWorkspace(created.workspace!.id);
      await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
      const hookRecordsBeforeRestore = await readFile(orderFile, "utf8");
      await client.close();
      await daemon.close();
      daemon = await createTestPaseoDaemon({
        paseoHomeRoot: path.join(root, "state"),
        cleanup: false,
        pluginsEnabled: true,
        plugins: {
          "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
        },
      });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.restoreWorkspace(created.workspace!.id);
      expect(await readFile(path.join(cwd, "from-plugin-base.txt"), "utf8")).toBe("base");
      expect(await readFile(orderFile, "utf8")).toBe(hookRecordsBeforeRestore);
      const beforeFailure = await client.fetchWorkspaces();
      const worktreesBeforeFailure = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repository,
        encoding: "utf8",
      });
      const rejected = await client.createWorkspace({
        source: {
          kind: "worktree",
          cwd: repository,
          branchName: "reject-hook",
          worktreeSlug: "reject-hook",
        },
      });
      expect(rejected.workspace).toBeNull();
      expect(rejected.error).toContain(
        "Plugin shutdown-provider-plugin worktree.create.after failed: worktree rejected",
      );
      const failedRecords = (await readFile(orderFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failedPath = failedRecords.at(-1).worktree.path;
      await expect(stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await client.fetchWorkspaces()).entries.map(({ id }) => id).sort()).toEqual(
        beforeFailure.entries.map(({ id }) => id).sort(),
      );
      expect(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: repository,
          encoding: "utf8",
        }),
      ).toBe(worktreesBeforeFailure);
    } finally {
      await client.close();
      await daemon.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  60_000,
);

test("worktree before hook rejects unsafe destinations with plugin attribution before creating branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-before-invalid-"));
  const repository = path.join(root, "repository");
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repository, stdio: "pipe" },
  );
  const occupied = path.join(root, "occupied");
  await mkdir(occupied);
  const destinations = [
    occupied,
    "relative/path",
    repository,
    path.join(repository, ".git", "worktree"),
    root,
    path.parse(root).root,
    (await import("node:os")).homedir(),
  ];
  const pluginDirectory = await createProviderPlugin(root, {
    acknowledgeClose: true,
    hooks: `
  server.addHook("worktree.create.before", async ({ request }) => {
    if (request.branch === "throws") throw new Error("creation denied");
    if (request.branch === "readonly") return { ...request, repoRoot: "/different-repository" };
    return { ...request, path: ${JSON.stringify(destinations)}[Number(request.branch.slice(4))] };
  });`,
  });
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    for (const branchName of [
      ...destinations.map((_, index) => `bad-${index}`),
      "throws",
      "readonly",
    ]) {
      const created = await client.createWorkspace({
        source: { kind: "worktree", cwd: repository, branchName, worktreeSlug: branchName },
      });
      expect(created.workspace).toBeNull();
      expect(created.error).toContain(
        "Plugin shutdown-provider-plugin worktree.create.before failed:",
      );
      expect(
        execFileSync("git", ["branch", "--format=%(refname:short)"], {
          cwd: repository,
          encoding: "utf8",
        }).trim(),
      ).toBe("main");
      expect(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: repository,
          encoding: "utf8",
        }).match(/^worktree /gm),
      ).toHaveLength(1);
    }
    expect((await client.fetchWorkspaces()).entries).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("the placement example creates a sibling worktree, opens its first agent there, lists and archives it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-placement-example-"));
  const repository = path.join(root, "repository");
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repository, stdio: "pipe" },
  );
  const providerDirectory = await createProviderPlugin(root, {
    acknowledgeClose: true,
    reportOpen: true,
  });
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(providerDirectory);
    const installed = await client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/worktree-placement", import.meta.url)),
    );
    expect(installed.status).toBe("running");
    const created = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repository,
        branchName: "feature/x",
        worktreeSlug: "feature-x",
      },
    });
    expect(created.error).toBeNull();
    const cwd = path.join(await realpath(root), "repository.feature-x");
    expect(created.workspace!.workspaceDirectory).toBe(cwd);
    expect((await stat(cwd)).isDirectory()).toBe(true);
    expect((await client.fetchWorkspaces()).entries.map((workspace) => workspace.id)).toContain(
      created.workspace!.id,
    );
    const worktrees = await client.getPaseoWorktreeList({ cwd: repository });
    expect(worktrees.error).toBeNull();
    expect(worktrees.worktrees).toContainEqual(
      expect.objectContaining({ worktreePath: cwd, branchName: "feature/x" }),
    );
    const collision = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repository,
        branchName: "feature/x",
        worktreeSlug: "another-slug",
      },
    });
    expect(collision.workspace).toBeNull();
    expect(collision.error).toContain("Plugin worktree-placement worktree.create.before failed:");
    expect(collision.error).toContain("already exists");
    const agent = await client.createAgent({
      provider: PROVIDER_ID,
      cwd,
      workspaceId: created.workspace!.id,
    });
    expect(agent.cwd).toBe(cwd);
    const logs = await client.getPluginLogs("shutdown-provider-plugin");
    const opened = logs
      .filter((entry) => entry.message.startsWith('{"hook":"provider.open"'))
      .map((entry) => JSON.parse(entry.message));
    expect(opened.map((entry) => entry.config.cwd)).toContain(cwd);
    await client.archiveWorkspace(created.workspace!.id);
    await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("worktree includes reach the first agent without copying tracked or unignored files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-include-"));
  const repository = path.join(root, "repository");
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "pipe" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  await mkdir(path.join(repository, "config"));
  await writeFile(path.join(repository, ".gitignore"), ".env\nconfig/*.local.json\n");
  await writeFile(
    path.join(repository, ".worktreeinclude"),
    ".env\nconfig/*.local.json\nunignored.txt\n",
  );
  await writeFile(path.join(repository, "config/tracked.local.json"), "git version");
  git("add", ".gitignore", ".worktreeinclude");
  git("add", "-f", "config/tracked.local.json");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial",
  );
  await writeFile(path.join(repository, ".env"), "SECRET=source");
  await writeFile(path.join(repository, "config/app.local.json"), "local config");
  await writeFile(path.join(repository, "config/tracked.local.json"), "uncommitted source version");
  await writeFile(path.join(repository, "unignored.txt"), "unignored source");
  const observed = path.join(root, "observed.json");
  const pluginDirectory = await createProviderPlugin(root, {
    acknowledgeClose: true,
    hooks: `
  server.addHook("agent.open.before", async ({ request }) => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const contents = await Promise.all([".env", "config/app.local.json", "config/tracked.local.json"].map(file => readFile(request.cwd + "/" + file, "utf8")));
    await writeFile(${JSON.stringify(observed)}, JSON.stringify(contents));
  });`,
  });
  const daemon = await createTestPaseoDaemon({ builtinPlugins: new BuiltinPluginLoader() });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client.installDirectoryPlugin(pluginDirectory)).status).toBe("running");
    const created = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "include", worktreeSlug: "include" },
    });
    expect(created.error).toBeNull();
    await client.createAgent({
      provider: PROVIDER_ID,
      cwd: created.workspace!.workspaceDirectory,
      workspaceId: created.workspace!.id,
    });
    expect(JSON.parse(await readFile(observed, "utf8"))).toEqual([
      "SECRET=source",
      "local config",
      "git version",
    ]);
    await expect(
      stat(path.join(created.workspace!.workspaceDirectory, "unignored.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const sourceWorktree = created.workspace!.workspaceDirectory;
    await writeFile(path.join(sourceWorktree, ".env"), "SECRET=worktree");
    await writeFile(path.join(sourceWorktree, "config/app.local.json"), "worktree config");
    const nested = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: sourceWorktree,
        branchName: "nested",
        worktreeSlug: "nested",
      },
    });
    expect(nested.error).toBeNull();
    await client.createAgent({
      provider: PROVIDER_ID,
      cwd: nested.workspace!.workspaceDirectory,
      workspaceId: nested.workspace!.id,
    });
    expect(JSON.parse(await readFile(observed, "utf8"))).toEqual([
      "SECRET=worktree",
      "worktree config",
      "git version",
    ]);

    execFileSync("git", ["add", "-f", ".env"], { cwd: sourceWorktree, stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "commit branch env",
      ],
      { cwd: sourceWorktree, stdio: "pipe" },
    );
    const existing = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repository,
        baseBranch: "include",
        branchName: "existing",
        worktreeSlug: "existing",
      },
    });
    expect(existing.error).toBeNull();
    await client.createAgent({
      provider: PROVIDER_ID,
      cwd: existing.workspace!.workspaceDirectory,
      workspaceId: existing.workspace!.id,
    });
    expect(JSON.parse(await readFile(observed, "utf8"))).toEqual([
      "SECRET=worktree",
      "local config",
      "git version",
    ]);

    await rm(path.join(repository, ".worktreeinclude"));
    const noIncludes = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repository,
        baseBranch: "main",
        branchName: "no-includes",
        worktreeSlug: "no-includes",
      },
    });
    expect(noIncludes.error).toBeNull();
    await expect(
      stat(path.join(noIncludes.workspace!.workspaceDirectory, ".env")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(path.join(noIncludes.workspace!.workspaceDirectory, "config/app.local.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path.join(repository, ".worktreeinclude"), ".env\nconfig/*.local.json\n");
    await rm(path.join(sourceWorktree, "config"), { recursive: true });
    await writeFile(
      path.join(sourceWorktree, "config"),
      "committed file blocks the config directory",
    );
    execFileSync("git", ["add", "-A", "config"], { cwd: sourceWorktree, stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "block config directory",
      ],
      { cwd: sourceWorktree, stdio: "pipe" },
    );
    const beforeFailure = await client.fetchWorkspaces();
    const worktreesBeforeFailure = git("worktree", "list", "--porcelain").toString();
    const failed = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repository,
        baseBranch: "include",
        branchName: "copy-failure",
        worktreeSlug: "copy-failure",
      },
    });
    expect(failed.workspace).toBeNull();
    expect(failed.error).toContain("Plugin worktree-include worktree.create.after failed:");
    expect((await client.fetchWorkspaces()).entries.map(({ id }) => id).sort()).toEqual(
      beforeFailure.entries.map(({ id }) => id).sort(),
    );
    expect(git("worktree", "list", "--porcelain").toString()).toBe(worktreesBeforeFailure);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
