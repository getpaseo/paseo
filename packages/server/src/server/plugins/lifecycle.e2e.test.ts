import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test, vi } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { OmpAgentClient } from "../agent/providers/omp/agent.js";
import { FakeOmp } from "../agent/providers/omp/test-utils/fake-omp.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import type { PluginMcpBindRequest } from "@getpaseo/plugin/server";

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
  server.on("agent.turn_started", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_started", event }));
  });
  server.on("agent.turn_ended", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_ended", event }));
  });
  server.on("agent.permission_requested", async (event, context) => {
    console.log(JSON.stringify({ hook: "agent.permission_requested", event }));
    await context.paseo.agents.ref(event.agent.id).respondToPermission({
      requestId: event.request.id,
      response: { behavior: "deny", message: "Declined by plugin" },
    });
  });
  server.on("agent.permission_resolved", (event) => {
    console.log(JSON.stringify({ hook: "agent.permission_resolved", event }));
  });
  server.on("agent.archived", (event) => {
    console.log(JSON.stringify({ hook: "agent.archived", event }));
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
        {
          hook: "agent.permission_requested",
          event: { request: { input: { command: "rm -f permission.txt" } } },
        },
        { hook: "agent.permission_resolved", event: { resolution: { behavior: "deny" } } },
        {
          hook: "agent.turn_ended",
          event: { outcome: { kind: "completed" }, timeline: [] },
        },
        { hook: "agent.turn_started", event: { agent: { id: agent.id } } },
      ]);
    const page = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 20 });
    expect(page.entries.length).toBeGreaterThan(0);
    await client.archiveAgent(agent.id);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("turn-hooks");
        return logs.filter((entry) => {
          return entry.message.startsWith('{"hook":"agent.archived"');
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
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "agent-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("agent.create", ({ request }) => {
    return { ...request, config: { ...request.config, provider: "codex" }, env: { ...request.env, HOOK_CREATE: "created" } };
  });
  server.before("agent.session_open", ({ request }) => {
    console.log(JSON.stringify({ hook: "agent.session_open", request }));
    return { ...request, env: { ...request.env, HOOK_OPEN: "opened" } };
  });
  server.on("agent.created", (event) => {
    console.log(JSON.stringify({ hook: "agent.created", event }));
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
      title: "Hook test",
    });
    expect(agent.provider).toBe("codex");
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("agent-hooks");
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
          hook: "agent.session_open",
          request: { agentId: agent.id, env: { HOOK_CREATE: "created" } },
        },
        { hook: "agent.created", event: { agent: { id: agent.id, provider: "codex" } } },
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
  server.before("workspace.create", () => {
    return { source: { kind: "worktree", branchName: 42 } };
  });
  server.before("workspace.create", ({ request }) => {
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
    expect(result.error).toContain("Plugin invalid-hook before workspace.create failed");
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
  options: { acknowledgeClose: boolean } = { acknowledgeClose: true },
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
  return () => undefined;
}`,
  );
  return directory;
}

test("a clean daemon shutdown leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-shutdown-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
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
  onTestFinished(() => rm(root, { recursive: true, force: true }));
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
  onTestFinished(() => rm(root, { recursive: true, force: true }));
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

function managedMcpResult(method: string) {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "managed", version: "1" },
    };
  }
  if (method === "tools/call") {
    return { content: [{ type: "text", text: "managed tool result" }] };
  }
  return {
    tools: [
      {
        name: "probe",
        description: "Managed probe",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
}

async function managedMcpHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-managed-mcp-"));
  const logger = pino({ level: "silent" });
  const runtime = new FakeOmp();
  const events: string[] = [];
  const bindings = new Map<string, PluginMcpBindRequest>();
  const current = new Map<string, string>();
  const credentials = new Map<string, string>();
  const consumed: string[] = [];
  let rejectMint = false;
  let firstBindBeforeSave = false;
  const fixture = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : {};
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/bind") {
      events.push("bind");
      if (input.reason === "create") {
        firstBindBeforeSave = (await daemon.daemon.agentStorage.get(input.agentId)) === null;
      }
      const prior = bindings.get(input.opening.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(input)) return json({}, 409);
      bindings.set(input.opening.id, input);
      current.set(input.agentId, input.opening.id);
      return json({
        openingId: input.opening.id,
        sessionEpoch: bindings.size,
        bindRequestId: input.opening.id,
      });
    }
    if (req.url === "/mint") {
      events.push("mint");
      const committed = bindings.get(input.binding.bindRequestId);
      if (
        !committed ||
        current.get(committed.agentId) !== input.session.opening.id ||
        input.binding.openingId !== committed.opening.id
      )
        return json({}, 403);
      if (rejectMint) return json({ message: "mint unavailable" }, 503);
      const credential = credentials.get(committed.opening.id) ?? `Bearer ${randomUUID()}`;
      credentials.set(committed.opening.id, credential);
      return json({ authorization: credential });
    }
    const authorizedOpening = [...credentials].find(
      ([, token]) => req.headers.authorization === token,
    )?.[0];
    const bound = authorizedOpening ? bindings.get(authorizedOpening) : undefined;
    if (!bound || current.get(bound.agentId) !== authorizedOpening) return json({}, 401);
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    consumed.push(authorizedOpening!);
    events.push("mcp");
    if (input.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result = managedMcpResult(input.method);
    return json({ jsonrpc: "2.0", id: input.id, result });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const url = `http://127.0.0.1:${address.port}`;
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      omp: new OmpAgentClient({ logger, runtime }),
      codex: createTestAgentClient("codex", { supportsMcpServers: true }),
    },
    mcpEnabled: false,
    logger,
    providerOverrides: { omp: { enabled: true } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.13.0",
  });
  onTestFinished(async () => {
    await client.close();
    await daemon.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  await client.patchDaemonConfig({ pluginsEnabled: true });
  for (const [id, source] of [
    [
      "z-binder",
      `
      server.before("agent.session_open", ({ request }, context) => {
        if (request.env.MANAGED_REQUIRED && !context.managedMcp) throw new Error("required declaration missing");
      });
      server.before("agent.mcp_bind", async ({ request }, context) => {
        if (!context.managedMcp.servers.some((s) => s.ownerPluginId === "a-owner" && s.bindPluginId === "z-binder"))
          throw new Error("unexpected owner");
        const response = await fetch("${url}/bind", { method: "POST", body: JSON.stringify(request) });
        if (!response.ok) throw new Error("bind refused");
        const env = { ...request.env };
        for (const key of request.bootstrapEnvKeys) delete env[key];
        return { ...request, env, binding: await response.json() };
      });`,
    ],
    [
      "a-owner",
      `
      const stage = ({ request }) => {
        if (request.config.title !== "managed") return;
        return { ...request, config: { ...request.config, mcpServers: {
          ...request.config.mcpServers,
          memory: { type: "http", url: "${url}/mcp", headers: { Authorization: "PASEO_MANAGED_MCP_INERT" } },
        } }, managedMcpServers: { memory: { bindPluginId: "z-binder", bootstrapEnvKeys: ["PASEO_MEMORY_BOOTSTRAP_REF"] } } };
      };
      server.before("agent.create", stage);
      server.before("agent.mcp_stage", ({ request }) => stage({ request: { ...request, config: { ...request.config, title: "managed" } } }));
      server.before("agent.mcp_authorization", async ({ request }) => {
        const response = await fetch("${url}/mint", { method: "POST", body: JSON.stringify(request) });
        if (!response.ok) throw new Error("mint refused");
        return { ...request, authorization: (await response.json()).authorization };
      });`,
    ],
  ]) {
    const plugin = path.join(directory, id!);
    await mkdir(plugin);
    await writeFile(
      path.join(plugin, "paseo-plugin.json"),
      JSON.stringify({ id, requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(plugin, "index.server.ts"),
      `export default function(server) { ${source} return () => {}; }`,
    );
    await client.installDirectoryPlugin(plugin);
  }
  return {
    directory,
    daemon,
    client,
    runtime,
    events,
    bindings,
    credentials,
    consumed,
    url,
    firstBindBeforeSave: () => firstBindBeforeSave,
    rejectMint: () => {
      rejectMint = true;
    },
  };
}

test("managed MCP binds before mint and provider access, stores inert config, and rolls over before old provider closure", async () => {
  const h = await managedMcpHarness();
  const input = {
    provider: "omp",
    cwd: h.directory,
    model: "anthropic/claude-haiku-5-5",
    title: "managed",
    env: { MANAGED_REQUIRED: "yes", PASEO_MEMORY_BOOTSTRAP_REF: "opaque-reference", REGION: "eu" },
    idempotencyKey: "managed-create",
  };
  const agent = await h.client.createAgent(input);
  const first = [...h.bindings.values()][0]!;
  const firstToken = h.credentials.get(first.opening.id)!;
  expect(h.events.slice(0, 3)).toEqual(["bind", "mint", "mcp"]);
  expect(h.firstBindBeforeSave()).toBe(true);
  const launch = h.runtime.recordedLaunches.find((entry) => entry.env?.PASEO_AGENT_ID === agent.id);
  expect(launch?.env?.REGION).toBe("eu");
  expect(launch?.env).not.toHaveProperty("PASEO_MEMORY_BOOTSTRAP_REF");
  expect(h.consumed).toContain(first.opening.id);
  const stored = await h.daemon.daemon.agentStorage.get(agent.id);
  expect(stored?.config?.mcpServers.memory.headers).toEqual({
    Authorization: "PASEO_MANAGED_MCP_INERT",
  });
  expect(stored?.config?.managedMcpServers?.memory?.ownerPluginId).toBe("a-owner");
  expect(JSON.stringify(stored)).not.toContain(firstToken);
  const replay = await h.client.createAgent(input);
  expect(replay.id).toBe(agent.id);
  expect(h.bindings.size).toBe(1);
  const oldRuntime = h.runtime.latestSession();
  const close = oldRuntime.close.bind(oldRuntime);
  oldRuntime.close = async () => {
    h.events.push("old-close");
    await close();
  };
  h.events.length = 0;
  await h.client.refreshAgent(agent.id, "managed-refresh-retry");
  expect(h.events.indexOf("bind")).toBeLessThan(h.events.indexOf("mint"));
  expect(h.events.indexOf("mint")).toBeLessThan(h.events.indexOf("old-close"));
  expect(h.events.indexOf("old-close")).toBeLessThan(h.events.indexOf("mcp"));
  expect(
    await fetch(`${h.url}/mcp`, {
      method: "POST",
      headers: { Authorization: firstToken },
      body: "{}",
    }).then((r) => r.status),
  ).toBe(401);
  expect(h.bindings.size).toBe(2);
  const second = [...h.bindings.values()][1]!;
  await h.client.refreshAgent(agent.id, "managed-refresh-retry");
  expect(h.bindings.size).toBe(2);
  expect(second.opening.id).not.toBe(first.opening.id);
  expect(second.env).not.toHaveProperty("PASEO_MEMORY_BOOTSTRAP_REF");
  expect(second.env.REGION).toBeUndefined();
  const current = h.daemon.daemon.agentManager.getAgent(agent.id)!;
  const handle = current.persistence!;
  await h.daemon.daemon.agentManager.closeAgent(agent.id);
  await h.daemon.daemon.agentManager.resumeAgentFromPersistence(handle, current.config, agent.id, {
    workspaceId: current.workspaceId,
  });
  expect([...h.bindings.values()][2]?.reason).toBe("resume");
  expect(h.bindings.size).toBe(3);
}, 60_000);

test("managed authorization failure fences the old fixture generation, quarantines unknown startup and never replays it", async () => {
  const h = await managedMcpHarness();
  const agent = await h.client.createAgent({
    provider: "omp",
    cwd: h.directory,
    model: "anthropic/claude-haiku-5-5",
    title: "managed",
  });
  const first = [...h.bindings.values()][0]!;
  const oldToken = h.credentials.get(first.opening.id)!;
  const oldRuntime = h.runtime.latestSession();
  const launches = h.runtime.recordedLaunches.length;
  h.rejectMint();
  await expect(h.daemon.daemon.agentManager.reloadAgentSession(agent.id)).rejects.toThrow(
    "authorization was not applied",
  );
  expect(oldRuntime.closed).toBe(false);
  expect(h.runtime.recordedLaunches).toHaveLength(launches);
  expect(
    await fetch(`${h.url}/mcp`, {
      method: "POST",
      headers: { Authorization: oldToken },
      body: "{}",
    }).then((r) => r.status),
  ).toBe(401);
  await expect(h.daemon.daemon.agentManager.reloadAgentSession(agent.id)).rejects.toThrow(
    "unknown outcome",
  );
  expect(h.bindings.size).toBe(2);
  expect(h.credentials.size).toBe(1);
  const existing = h.daemon.daemon.agentManager.getAgent(agent.id)!;
  const unfinishedAgentId = randomUUID();
  await expect(
    h.client.createAgent({
      agentId: unfinishedAgentId,
      provider: "omp",
      cwd: h.directory,
      model: "anthropic/claude-haiku-5-5",
      title: "managed",
    }),
  ).rejects.toThrow("authorization was not applied");
  await h.client.archiveAgent(agent.id);
  await h.client.disablePlugin("a-owner");
  await h.client.disablePlugin("z-binder");
  const eventCount = h.events.length;
  const history = await h.daemon.daemon.agentManager.resumeAgentFromPersistence(
    existing.persistence!,
    existing.config,
    agent.id,
    { workspaceId: existing.workspaceId },
    { purpose: "history" },
  );
  expect(h.events).toHaveLength(eventCount);
  expect(h.runtime.recordedLaunches).toHaveLength(launches);
  await expect(history.session.run("must not execute")).rejects.toThrow(
    "history session cannot start",
  );
  await expect(
    h.daemon.daemon.agentManager.createAgent(
      {
        provider: "omp",
        cwd: h.directory,
      },
      agent.id,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow();
  await expect(
    h.daemon.daemon.agentManager.createAgent(
      {
        provider: "omp",
        cwd: h.directory,
      },
      unfinishedAgentId,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("unknown outcome");
  expect(h.events).toHaveLength(eventCount);
  expect(h.runtime.recordedLaunches).toHaveLength(launches);
  const stored = await h.daemon.daemon.agentStorage.get(agent.id);
  expect(stored?.config?.managedMcpServers?.memory?.ownerPluginId).toBe("a-owner");
}, 60_000);

test("unsupported provider, absent obligation and unloaded required hooks cannot start a managed provider", async () => {
  const h = await managedMcpHarness();
  await expect(
    h.client.createAgent({ provider: "codex", cwd: h.directory, title: "managed" }),
  ).rejects.toThrow("cannot deliver managed MCP");
  expect(h.bindings.size).toBe(0);
  await expect(
    h.daemon.daemon.agentManager.createAgent(
      {
        provider: "omp",
        cwd: h.directory,
        title: "managed",
        model: "anthropic/claude-haiku-5-5",
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("durable native creation receipt");
  expect(h.bindings.size).toBe(0);
  await expect(
    h.client.createAgent({ provider: "omp", cwd: h.directory, env: { MANAGED_REQUIRED: "yes" } }),
  ).rejects.toThrow("required declaration missing");
  await h.client.disablePlugin("z-binder");
  await expect(
    h.client.createAgent({ provider: "omp", cwd: h.directory, title: "managed" }),
  ).rejects.toThrow("Required managed MCP plugin hook");
  expect(h.bindings.size).toBe(0);
  const ordinary = await h.client.createAgent({
    provider: "omp",
    cwd: h.directory,
    model: "anthropic/claude-haiku-5-5",
  });
  expect(ordinary.provider).toBe("omp");
}, 60_000);

test("managed native import stages attested inert servers and binds the actual import opening", async () => {
  const h = await managedMcpHarness();
  const nativeFile = path.join(h.directory, "import.jsonl");
  await writeFile(
    nativeFile,
    JSON.stringify({
      type: "session",
      id: randomUUID(),
      cwd: h.directory,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  const agent = await h.client.importAgent({
    providerId: "omp",
    providerHandleId: nativeFile,
    cwd: h.directory,
  });
  const opening = [...h.bindings.values()][0]!;
  expect(opening.agentId).toBe(agent.id);
  expect(opening.reason).toBe("import");
  expect(h.consumed).toContain(opening.opening.id);
  const stored = await h.daemon.daemon.agentStorage.get(agent.id);
  expect(stored?.config?.managedMcpServers?.memory?.ownerPluginId).toBe("a-owner");
  expect(JSON.stringify(stored)).not.toContain(h.credentials.get(opening.opening.id)!);
}, 60_000);

test("reloaded hook ownership fences queued host tool dispatch without requiring service revocation", async () => {
  const h = await managedMcpHarness();
  await h.client.createAgent({
    provider: "omp",
    cwd: h.directory,
    model: "anthropic/claude-haiku-5-5",
    title: "managed",
  });
  const runtime = h.runtime.latestSession();
  const tool = runtime.hostToolSetRequests
    .flat()
    .find((entry) => entry.name.startsWith("mcp_memory__probe"))!;
  expect(tool.name).toMatch(/^mcp_memory__probe/);
  await h.client.reloadPlugin("a-owner");
  const consumed = h.consumed.length;
  const result = runtime.nextHostToolResult();
  runtime.emit({
    type: "host_tool_call",
    id: "late-call",
    toolCallId: "late-tool",
    toolName: tool.name,
    arguments: {},
  });
  expect(await result).toMatchObject({ isError: true, result: { isError: true } });
  expect(h.consumed).toHaveLength(consumed);
}, 60_000);

test.skipIf(process.platform === "win32")(
  "unsupported directory sync refuses managed bind without affecting ordinary creation",
  async () => {
    const h = await managedMcpHarness();
    const input = {
      agentId: randomUUID(),
      idempotencyKey: "managed-durability-failure",
      provider: "omp",
      cwd: h.directory,
      title: "managed",
      model: "anthropic/claude-haiku-5-5",
    };
    const open = fs.open.bind(fs);
    const root = path.parse(h.directory).root;
    const fault = vi
      .spyOn(fs, "open")
      .mockImplementation((file, flags, mode) =>
        file === root
          ? Promise.reject(
              Object.assign(new Error("directory sync unsupported"), { code: "ENOTSUP" }),
            )
          : open(file, flags, mode),
      );
    try {
      await expect(h.client.createAgent(input)).rejects.toThrow();
      expect(h.bindings.size).toBe(0);
      expect(h.consumed).toEqual([]);
      expect(
        h.runtime.recordedLaunches.some((launch) => launch.env?.PASEO_AGENT_ID === input.agentId),
      ).toBe(false);
      expect(await h.daemon.daemon.agentStorage.get(input.agentId)).toBeNull();
      const ordinary = await h.client.createAgent({
        provider: "omp",
        cwd: h.directory,
        model: "anthropic/claude-haiku-5-5",
      });
      expect(ordinary.provider).toBe("omp");
    } finally {
      fault.mockRestore();
    }
    await expect(h.client.createAgent(input)).rejects.toThrow();
    expect(h.bindings.size).toBe(0);
  },
  60_000,
);
