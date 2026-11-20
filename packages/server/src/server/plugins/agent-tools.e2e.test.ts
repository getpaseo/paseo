import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import {
  DaemonClient as PublicDaemonClient,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  createTestAgentClient,
  type TestAgentClientOptions,
} from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { importSessionFromPersistence } from "../agent/provider-session-import.js";
import { BuiltinPluginLoader } from "./builtin/index.js";
import { serializePaseoToolInputParameters } from "../agent/tools/paseo-tool-serialization.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSessionConfig,
  AgentPromptInput,
} from "../agent/agent-sdk-types.js";

function recordingProvider(native: boolean, callbacks: TestAgentClientOptions = {}) {
  const launches: { config: AgentSessionConfig; context?: AgentLaunchContext }[] = [];
  const turns: { prompt: AgentPromptInput; launchCount: number }[] = [];
  const steers: AgentPromptInput[] = [];
  const events = { interrupts: 0 };
  const inner = createTestAgentClient("codex", {
    ...callbacks,
    supportsMcpServers: callbacks.supportsMcpServers ?? true,
    onStartTurn: (prompt, config) => {
      turns.push({ prompt, launchCount: launches.length });
      callbacks.onStartTurn?.(prompt, config);
    },
    steerActiveTurn: async (prompt) => {
      steers.push(prompt);
      return { status: "accepted" };
    },
    onInterrupt: () => {
      events.interrupts++;
      callbacks.onInterrupt?.();
    },
  });
  const provider: AgentClient = {
    provider: inner.provider,
    capabilities: { ...inner.capabilities, supportsNativePaseoTools: native },
    createSession: async (config, context, options) => {
      launches.push({ config, context });
      return inner.createSession(config, context, options);
    },
    resumeSession: async (handle, config, context, options) => {
      launches.push({ config: config as AgentSessionConfig, context });
      return inner.resumeSession(handle, config, context, options);
    },
    importSession: (input, context) =>
      importSessionFromPersistence({
        provider: "codex",
        request: input,
        context,
        resumeSession: provider.resumeSession.bind(provider),
      }),
    isAvailable: () => inner.isAvailable(),
    fetchCatalog: (options) => inner.fetchCatalog(options),
  };
  return { provider, launches, turns, steers, events };
}

test("failed replacement preparation preserves the live HTTP tool catalog", async () => {
  const fixture = await setup();
  try {
    const agent = await fixture.create({ x: "y" });
    const mcp = await fixture.mcp();
    const before = await mcp.callTool({ name: "plugin_echo", arguments: { text: "before" } });
    expect(before, JSON.stringify(before)).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining('"text":"before"') }],
    });
    await fixture.install(
      "later-rejection",
      `export default function contribute(server) {
      server.addHook("agent.open.before", async () => { throw new Error("replacement preparation failed"); });
      return () => {};
    }`,
    );
    await expect(fixture.daemon.daemon.agentManager.reloadAgentSession(agent.id)).rejects.toThrow(
      "replacement preparation failed",
    );
    const after = await mcp.callTool({ name: "plugin_echo", arguments: { text: "after" } });
    expect(after.isError).not.toBe(true);
    expect(after.content).toEqual([
      { type: "text", text: expect.stringContaining('"text":"after"') },
    ]);
  } finally {
    await fixture.close();
  }
});

test("unopted SDK consumers receive copy-safe snapshots before and after reconnect without changing a capable client's effective view", async () => {
  const fixture = await setup(
    false,
    pluginSource.replace(
      "tools: [...request.tools, tool]",
      "providerOptions: { test_feature: true }, tools: [...request.tools, tool]",
    ),
  );
  function observer(clientId: string, projection: boolean) {
    const sockets: WebSocket[] = [];
    const client = new PublicDaemonClient({
      url: `ws://127.0.0.1:${fixture.daemon.port}/ws`,
      clientId,
      capabilities: { agent_template_projection: projection },
      reconnect: { enabled: false },
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
    });
    return { client, sockets };
  }
  const legacyObserver = observer("copy-safe-legacy", false);
  const capableObserver = observer("copy-safe-capable", true);
  const legacyClient = legacyObserver.client;
  const capable = capableObserver.client;
  try {
    await legacyClient.connect();
    await capable.connect();
    const legacyListing = await legacyClient.fetchAgents({ subscribe: {} });
    const capableListing = await capable.fetchAgents({ subscribe: {} });
    const workspace = await fixture.client.createWorkspace({
      source: { kind: "directory", path: fixture.directory },
    });
    const created = await fixture.daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: fixture.directory },
      undefined,
      { labels: { x: "y" }, workspaceId: workspace.workspace!.id },
    );
    expect(created.effectiveOptions).toMatchObject({ test_feature: true });
    const legacy = await legacyClient.fetchAgent({ agentId: created.id });
    const modern = await capable.fetchAgent({ agentId: created.id });
    expect(legacy).not.toBeNull();
    expect(modern).toMatchObject({ agent: { options: { test_feature: true } } });
    expect(legacy!.agent.options?.test_feature).toBeUndefined();
    const legacyDirectoryEntry = (await legacyClient.fetchAgents()).entries.find(
      (entry) => entry.agent.id === created.id,
    );
    expect(legacyDirectoryEntry).toBeDefined();
    expect(legacyDirectoryEntry!.agent.options?.test_feature).toBeUndefined();
    const capableDirectory = await capable.fetchAgents();
    expect(capableDirectory.entries, JSON.stringify(capableDirectory)).toContainEqual(
      expect.objectContaining({
        agent: expect.objectContaining({
          id: created.id,
          options: expect.objectContaining({ test_feature: true }),
        }),
      }),
    );
    expect(
      (await capable.getAgentTemplate(created.id)).providerOptions?.test_feature,
    ).toBeUndefined();
    const legacySnapshots: Array<{ present: boolean; option: unknown }> = [];
    const capableSnapshots: Array<{ present: boolean; option: unknown }> = [];
    const legacyUpdates: Array<NonNullable<typeof legacy>["agent"]> = [];
    const capableUpdates: Array<NonNullable<typeof modern>["agent"]> = [];
    legacyListing.subscription.subscribe({
      snapshot(value) {
        const entry = value.entries.find((candidate) => candidate.agent.id === created.id);
        legacySnapshots.push({
          present: entry !== undefined,
          option: entry?.agent.options?.test_feature,
        });
      },
      update(message) {
        if (message.type === "agent_update" && message.payload.kind === "upsert") {
          legacyUpdates.push(message.payload.agent);
        }
      },
    });
    capableListing.subscription.subscribe({
      snapshot(value) {
        const entry = value.entries.find((candidate) => candidate.agent.id === created.id);
        capableSnapshots.push({
          present: entry !== undefined,
          option: entry?.agent.options?.test_feature,
        });
      },
      update(message) {
        if (message.type === "agent_update" && message.payload.kind === "upsert") {
          capableUpdates.push(message.payload.agent);
        }
      },
    });
    legacySnapshots.length = 0;
    capableSnapshots.length = 0;
    legacyObserver.sockets[0]!.terminate();
    capableObserver.sockets[0]!.terminate();
    await expect.poll(() => legacyClient.getConnectionState().status).toBe("disconnected");
    await expect.poll(() => capable.getConnectionState().status).toBe("disconnected");
    await legacyClient.connect();
    await capable.connect();
    await expect.poll(() => legacySnapshots).toContainEqual({ present: true, option: undefined });
    await expect.poll(() => capableSnapshots).toContainEqual({ present: true, option: true });
    const legacyReconnected = await legacyClient.fetchAgents();
    const capableReconnected = await capable.fetchAgents();
    expect(legacyObserver.sockets).toHaveLength(2);
    expect(capableObserver.sockets).toHaveLength(2);
    expect(legacyReconnected.entries).toContainEqual(
      expect.objectContaining({ agent: expect.objectContaining({ id: created.id }) }),
    );
    expect(
      legacyReconnected.entries.find((entry) => entry.agent.id === created.id)!.agent.options
        ?.test_feature,
    ).toBeUndefined();
    expect(capableReconnected.entries).toContainEqual(
      expect.objectContaining({
        agent: expect.objectContaining({
          id: created.id,
          options: expect.objectContaining({ test_feature: true }),
        }),
      }),
    );
    const legacyAfterReconnect = await legacyClient.fetchAgent(created.id);
    expect(legacyAfterReconnect).not.toBeNull();
    expect(legacyAfterReconnect!.agent.options?.test_feature).toBeUndefined();
    expect(await capable.fetchAgent(created.id)).toMatchObject({
      agent: { options: { test_feature: true } },
    });
    expect(modern!.agent.options).toMatchObject({ test_feature: true });
    expect(
      fixture.daemon.daemon.agentManager.getAgent(created.id)!.effectiveOptions.test_feature,
    ).toBe(true);
    const sourceRecord = await fixture.daemon.daemon.agentStorage.get(created.id);
    expect(sourceRecord).not.toBeNull();
    expect(sourceRecord!.config?.providerOptions?.test_feature).toBeUndefined();
    const legacySeed = (await legacyClient.fetchAgent(created.id))!.agent;
    const copied = await legacyClient.createAgent({
      provider: legacySeed.provider,
      cwd: legacySeed.cwd,
      workspaceId: workspace.workspace!.id,
      providerOptions: legacySeed.options,
      labels: { x: "y" },
    });
    expect(copied.id).not.toBe(created.id);
    expect(copied.options?.test_feature).toBeUndefined();
    expect(
      (await fixture.daemon.daemon.agentStorage.get(copied.id))?.config?.providerOptions
        ?.test_feature,
    ).toBeUndefined();
    expect(
      fixture.daemon.daemon.agentManager.getAgent(copied.id)!.effectiveOptions.test_feature,
    ).toBe(true);
    expect(await capable.fetchAgent(copied.id)).toMatchObject({
      agent: { options: { test_feature: true } },
    });
    expect(await capable.fetchAgent(created.id)).toMatchObject({
      agent: { options: { test_feature: true } },
    });
    await fixture.daemon.daemon.agentManager.closeAgent(created.id);
    await expect
      .poll(() =>
        legacyUpdates.find((agent) => agent.id === created.id && agent.status === "closed"),
      )
      .toMatchObject({ id: created.id, status: "closed" });
    await expect
      .poll(() =>
        capableUpdates.find((agent) => agent.id === created.id && agent.status === "closed"),
      )
      .toMatchObject({ id: created.id, status: "closed" });
    const legacyClosed = legacyUpdates.find(
      (agent) => agent.id === created.id && agent.status === "closed",
    )!;
    const capableClosed = capableUpdates.find(
      (agent) => agent.id === created.id && agent.status === "closed",
    )!;
    expect(
      legacyClosed.options?.test_feature,
      "An unopted client's queued closed update must not expose the temporary plugin option",
    ).toBeUndefined();
    expect(legacyClosed.features).toContainEqual(
      expect.objectContaining({ id: "test_feature", value: false }),
    );
    expect(capableClosed.options).toMatchObject({ test_feature: true });
    expect(capableClosed.features).toContainEqual(
      expect.objectContaining({ id: "test_feature", value: true }),
    );
    const copiedClosed = await legacyClient.createAgent({
      provider: legacyClosed.provider,
      cwd: legacyClosed.cwd,
      workspaceId: workspace.workspace!.id,
      providerOptions: legacyClosed.options,
      labels: { x: "y" },
    });
    expect(copiedClosed.id).not.toBe(created.id);
    expect(copiedClosed.options?.test_feature).toBeUndefined();
    expect(
      (await fixture.daemon.daemon.agentStorage.get(copiedClosed.id))?.config?.providerOptions
        ?.test_feature,
    ).toBeUndefined();
    expect(await capable.fetchAgent(copiedClosed.id)).toMatchObject({
      agent: { options: { test_feature: true } },
    });
  } finally {
    await legacyClient.close();
    await capable.close();
    await fixture.close();
  }
});

test("built CLI legacy preview lists candidates without exposing saved secrets or raw receipts", async () => {
  const fixture = await setup(
    false,
    `export default function contribute(server) {
    server.registerLegacyAgentConfig({ version: 1, selectors: [
      { id: "saved-prompt", group: "instructions", label: "Saved instructions", kind: "prompt-suffix", text: "\\n\\ndummy-cli-prompt-secret" },
      { id: "saved-endpoint", group: "tools", label: "Saved endpoint", kind: "mcp", name: "legacy" },
      { id: "saved-env", group: "environment", label: "Saved environment", kind: "env", key: "LEGACY_TOKEN", baselines: [{ id: "inherit", label: "Inherit environment", kind: "absent" }] },
      { id: "saved-option", group: "options", label: "Saved option", kind: "option", key: "legacy_option", baselines: [{ id: "inherit", label: "Inherit option", kind: "absent" }] },
    ] });
    return () => {};
  }`,
  );
  try {
    const agent = await fixture.daemon.daemon.agentManager.createAgent(
      {
        provider: "codex",
        cwd: fixture.directory,
        systemPrompt: "Caller instructions\n\ndummy-cli-prompt-secret",
        mcpServers: {
          legacy: {
            type: "http",
            url: "http://127.0.0.1:1/dummy-cli-url-secret",
            headers: { Authorization: "Bearer dummy-cli-header-secret" },
          },
        },
        providerOptions: { legacy_option: "dummy-cli-option-secret" },
      },
      undefined,
      { env: { LEGACY_TOKEN: "dummy-cli-env-secret" } },
    );
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../../../../cli/bin/paseo", import.meta.url)),
        "agent",
        "plugin-config",
        "preview",
        agent.id,
        "--plugin",
        "tools-test",
        "--host",
        `127.0.0.1:${fixture.daemon.port}`,
        "--json",
      ],
      {
        cwd: fixture.directory,
        env: {
          HOME: fixture.directory,
          USERPROFILE: fixture.directory,
          PASEO_HOME: fixture.directory,
          CI: "1",
        },
        timeout: 15_000,
      },
    );
    const output = JSON.parse(stdout);
    expect(output).toMatchObject({
      agentId: agent.id,
      pluginId: "tools-test",
      operation: "preview",
    });
    const preview = JSON.parse(output.details);
    expect(preview).toMatchObject({
      expectedFingerprint: expect.any(String),
      candidates: [
        { id: "saved-prompt", group: "instructions", label: "Saved instructions" },
        { id: "saved-endpoint", group: "tools", label: "Saved endpoint" },
        { id: "saved-env", group: "environment", label: "Saved environment" },
        { id: "saved-option", group: "options", label: "Saved option" },
      ],
      receiptIds: [],
    });
    expect(stdout + stderr).not.toContain("dummy-cli-prompt-secret");
    expect(stdout + stderr).not.toContain("dummy-cli-url-secret");
    expect(stdout + stderr).not.toContain("dummy-cli-header-secret");
    expect(stdout + stderr).not.toContain("dummy-cli-env-secret");
    expect(stdout + stderr).not.toContain("dummy-cli-option-secret");
    expect(stdout + stderr).not.toMatch(
      /pluginConfigAdoptions|recipeDigest|fragmentDigest|"fragment"/,
    );
    expect(fixture.turns).toEqual([]);
    expect(fixture.launches).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 60_000);

test("legacy preview apply reset keeps original records and projects only explicitly adopted fragments", async () => {
  const fixture = await setup(
    false,
    `export default function contribute(server) {
    server.registerLegacyAgentConfig({ version: 1, selectors: [
      { id: "saved-prompt", group: "notes", label: "Saved note instructions", kind: "prompt-suffix", text: "\\n\\nLegacy notes" },
    ] });
    return () => {};
  }`,
  );
  try {
    const agent = await fixture.daemon.daemon.agentManager.createAgent(
      {
        provider: "codex",
        cwd: fixture.directory,
        systemPrompt: "Caller instructions\n\nLegacy notes",
      },
      undefined,
      { workspaceId: undefined },
    );
    const original = (await fixture.daemon.daemon.agentStorage.get(agent.id))!.config;
    const preview = await fixture.client.previewLegacyPluginConfig(agent.id, {
      pluginId: "tools-test",
      operation: "adopt",
    });
    expect(preview.candidates).toEqual([
      expect.objectContaining({ id: "saved-prompt", field: "prompt-suffix" }),
    ]);
    const applied = await fixture.client.applyLegacyPluginConfig(agent.id, {
      pluginId: "tools-test",
      expectedFingerprint: preview.expectedFingerprint,
      selections: [{ id: "saved-prompt" }],
    });
    expect(applied.appliesOn).toBe("next-open");
    expect((await fixture.client.getAgentTemplate(agent.id)).providerOptions ?? {}).toEqual({});
    expect(
      (await fixture.daemon.daemon.agentManager.getAgentTemplateConfig(agent.id)).systemPrompt,
    ).toBe("Caller instructions");
    expect((await fixture.daemon.daemon.agentStorage.get(agent.id))!.config).toEqual(original);
    await expect(
      fixture.client.applyLegacyPluginConfig(agent.id, {
        pluginId: "tools-test",
        expectedFingerprint: preview.expectedFingerprint,
        selections: [{ id: "saved-prompt" }],
      }),
    ).rejects.toThrow("stale");
    const reset = await fixture.client.previewLegacyPluginConfig(agent.id, {
      pluginId: "tools-test",
      operation: "reset",
    });
    await fixture.client.resetLegacyPluginConfig(agent.id, {
      pluginId: "tools-test",
      expectedFingerprint: reset.expectedFingerprint,
      receiptIds: applied.receiptIds,
    });
    expect(
      (await fixture.daemon.daemon.agentManager.getAgentTemplateConfig(agent.id)).systemPrompt,
    ).toBe("Caller instructions\n\nLegacy notes");
  } finally {
    await fixture.close();
  }
});

const pluginSource = `
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
let calls = 0;
const tool = defineAgentTool({
  name: "plugin_echo", description: "Echo for the chosen agent",
  input: z.object({ text: z.string().min(1).refine(value => value !== "forbidden", "Forbidden by plugin").describe("Message") }),
  async execute(input, { agent, paseo, signal }) {
    calls++;
    if (input.text === "throw") throw new Error("handler failed");
    return { text: JSON.stringify({ agent, input, calls, sdk: typeof paseo.agents.ref, aborted: signal.aborted }) };
  },
});
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.labels.x !== "y") return;
    return { ...request, env: { ...request.env, OPEN_INFO: JSON.stringify({ title: request.title, labels: request.labels, reason: request.reason }) }, tools: [...request.tools, tool] };
  });
  return () => {};
}
`;

const launchLifetimeSource = `
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }, { launch }) => {
    const reason = request.reason;
    launch.onInstalled(async () => {
      await appendFile(request.cwd + "/launch-events", "installed:" + reason + "\\n");
    });
    launch.onDispose(async ({ installed }) => {
      await appendFile(request.cwd + "/launch-events", "disposed:" + reason + ":" + installed + ":" + launch.signal.aborted + "\\n");
    });
    const tool = defineAgentTool({ name: "plugin_echo", description: "Opening-bound handler",
      input: z.object({}), execute: () => ({ text: reason + ":" + launch.signal.aborted }) });
    return { ...request, tools: [tool] };
  });
  return () => {};
}
`;

test("a timed-out old close preserves the original HTTP tool catalog and launch resources", async () => {
  let finishClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const h = await setup(false, launchLifetimeSource, undefined, { closeSession: () => closeGate });
  try {
    const agent = await h.create();
    const mcp = await h.mcp();
    await expect(h.daemon.daemon.agentManager.reloadAgentSession(agent.id)).rejects.toThrow(
      "Timed out closing previous session during refresh",
    );
    expect(h.launches).toHaveLength(1);
    expect(h.daemon.daemon.agentManager.getAgent(agent.id)?.lifecycle).toBe("error");
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    expect(await mcp.callTool({ name: "plugin_echo", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "create:false" }],
    });
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\ndisposed:refresh:false:true\n",
    );
  } finally {
    finishClose();
    await h.close();
  }
}, 60_000);

test("a confirmed old close followed by provider failure leaves no active tool catalog", async () => {
  const h = await setup(false, launchLifetimeSource, undefined, {
    beforeResumeSession: async () => {
      throw new Error("replacement provider failed");
    },
  });
  try {
    const agent = await h.create();
    const mcp = await h.mcp();
    await expect(h.daemon.daemon.agentManager.reloadAgentSession(agent.id)).rejects.toThrow(
      "replacement provider failed",
    );
    expect(h.daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();
    expect(h.daemon.daemon.agentManager.getPluginTools(agent.id)).toEqual([]);
    expect(await h.daemon.daemon.agentStorage.get(agent.id)).toMatchObject({
      lastStatus: "closed",
    });
    await expect(mcp.listTools()).rejects.toThrow("Error POSTing to endpoint");
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\ndisposed:create:true:true\ndisposed:refresh:false:true\n",
    );
  } finally {
    await h.close();
  }
}, 60_000);

const failedDisposalSource = launchLifetimeSource.replace(
  '"disposed:" + reason + ":" + installed + ":" + launch.signal.aborted + "\\n");',
  '"disposed:" + reason + ":" + installed + ":" + launch.signal.aborted + "\\n");\n      if (reason === "create") throw new Error("original launch cleanup failed");',
);

test("confirmed provider close publishes closed state even when plugin disposal fails", async () => {
  let closes = 0;
  const h = await setup(true, failedDisposalSource, undefined, {
    closeSession: async () => {
      closes++;
    },
  });
  try {
    const agent = await h.create();
    const manager = h.daemon.daemon.agentManager;
    const catalog = h.launches[0]!.context!.paseoTools!;
    const mcp = await h.mcp(agent.id);
    await expect(manager.closeAgent(agent.id)).rejects.toThrow(/plugin launch disposal failed/i);
    expect(closes).toBe(1);
    expect(
      manager.getAgent(agent.id),
      "Confirmed provider close must remove active ownership even when cleanup fails",
    ).toBeNull();
    expect(await h.daemon.daemon.agentStorage.get(agent.id)).toMatchObject({
      lastStatus: "closed",
    });
    expect(manager.getPluginTools(agent.id)).toEqual([]);
    await expect(catalog.executeTool("plugin_echo", {})).rejects.toThrow("disposed");
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    await expect(manager.closeAgent(agent.id)).resolves.toBeUndefined();
    expect(closes).toBe(1);
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\ndisposed:create:true:true\n",
    );
    await expect(h.daemon.daemon.stop()).rejects.toThrow(/plugin launch disposal failed/i);
    await expect(fetch(`http://127.0.0.1:${h.daemon.port}/api/health`)).rejects.toThrow();
  } finally {
    await h.close();
  }
}, 60_000);

test("refresh cleanup failure leaves the confirmed-closed provider inactive without opening a replacement", async () => {
  let closes = 0;
  const h = await setup(true, failedDisposalSource, undefined, {
    closeSession: async () => {
      closes++;
    },
  });
  try {
    const agent = await h.create();
    const manager = h.daemon.daemon.agentManager;
    const catalog = h.launches[0]!.context!.paseoTools!;
    const mcp = await h.mcp(agent.id);
    await expect(manager.reloadAgentSession(agent.id)).rejects.toThrow(
      /plugin launch disposal failed/i,
    );
    expect(closes).toBe(1);
    expect(h.launches).toHaveLength(1);
    expect(
      manager.getAgent(agent.id),
      "Refresh cleanup failure must not retain a confirmed-closed provider as active",
    ).toBeNull();
    expect(await h.daemon.daemon.agentStorage.get(agent.id)).toMatchObject({
      lastStatus: "closed",
    });
    expect(manager.getPluginTools(agent.id)).toEqual([]);
    await expect(catalog.executeTool("plugin_echo", {})).rejects.toThrow("disposed");
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    await expect(manager.closeAgent(agent.id)).resolves.toBeUndefined();
    expect(closes).toBe(1);
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\ndisposed:create:true:true\ndisposed:refresh:false:true\n",
    );
  } finally {
    await h.close();
  }
}, 60_000);

test("a provisional same-named handler cannot retarget live native or HTTP tool dispatch", async () => {
  const h = await setup(true, launchLifetimeSource);
  let releasePreparation: (() => Promise<unknown>) | undefined;
  let reloading: Promise<unknown> | undefined;
  try {
    await h.install(
      "zz-hold-opening",
      `
import { writeFile } from "node:fs/promises";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  server.handle(defineRpc({ name: "release", input: z.object({}), output: z.object({}) }), async () => {
    release();
    return {};
  });
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.reason === "refresh") {
      await writeFile(request.cwd + "/replacement-prepared", "ready");
      await gate;
    }
    return request;
  });
  return () => {};
}`,
    );
    releasePreparation = () => h.client.invokePluginRpc("zz-hold-opening", "release", {});
    const agent = await h.create();
    const original = h.launches[0]!.context!.paseoTools!;
    const mcp = await h.mcp(agent.id);
    reloading = h.daemon.daemon.agentManager.reloadAgentSession(agent.id).then(
      (replacement) => ({ replacement }),
      (error: unknown) => ({ error }),
    );
    await expect
      .poll(() => readFile(path.join(h.directory, "replacement-prepared"), "utf8"))
      .toBe("ready");
    expect(await original.executeTool("plugin_echo", {})).toMatchObject({
      content: [{ type: "text", text: "create:false" }],
    });
    expect(await mcp.callTool({ name: "plugin_echo", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "create:false" }],
    });
    await releasePreparation();
    expect(await reloading).toMatchObject({ replacement: { id: agent.id } });
    expect(await h.launches[1]!.context!.paseoTools!.executeTool("plugin_echo", {})).toMatchObject({
      content: [{ type: "text", text: "refresh:false" }],
    });
    expect(await mcp.callTool({ name: "plugin_echo", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "refresh:false" }],
    });
    await expect(original.executeTool("plugin_echo", {})).rejects.toThrow("disposed");
  } finally {
    await releasePreparation?.();
    await reloading;
    await h.close();
  }
}, 60_000);

test("an installation callback failure closes the replacement once before disposing its installed launch", async () => {
  let closes = 0;
  let finishClose!: () => void;
  let startedClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const closeStarted = new Promise<void>((resolve) => {
    startedClose = resolve;
  });
  let reloading: Promise<unknown> | undefined;
  const h = await setup(
    true,
    launchLifetimeSource.replace(
      '"installed:" + reason + "\\n");',
      '"installed:" + reason + "\\n");\n      if (reason === "refresh") throw new Error("installation callback failed");',
    ),
    undefined,
    {
      closeSession: async () => {
        closes++;
        if (closes === 1) return;
        startedClose();
        await closeGate;
      },
    },
  );
  try {
    const agent = await h.create();
    reloading = h.daemon.daemon.agentManager.reloadAgentSession(agent.id).then(
      (replacement) => ({ replacement }),
      (error: unknown) => ({ error }),
    );
    await closeStarted;
    expect(h.daemon.daemon.agentManager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(await h.launches[1]!.context!.paseoTools!.executeTool("plugin_echo", {})).toMatchObject({
      content: [{ type: "text", text: "refresh:false" }],
    });
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\ndisposed:create:true:true\ninstalled:refresh\n",
    );
    finishClose();
    expect(await reloading).toMatchObject({ error: { message: "installation callback failed" } });
    expect(closes).toBe(2);
    expect(h.daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();
    expect(h.daemon.daemon.agentManager.getPluginTools(agent.id)).toEqual([]);
    expect(await h.daemon.daemon.agentStorage.get(agent.id)).toMatchObject({
      lastStatus: "closed",
      lastError: "installation callback failed",
    });
    await expect(
      h.launches[1]!.context!.paseoTools!.executeTool("plugin_echo", {}),
    ).rejects.toThrow("Agent is not live");
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\ndisposed:create:true:true\ninstalled:refresh\ndisposed:refresh:true:true\n",
    );
  } finally {
    finishClose();
    await reloading;
    await h.close();
  }
}, 60_000);

test("an installation callback failure with rejected close keeps the live session and tools until confirmed close", async () => {
  let rejectClose = true;
  let closes = 0;
  const h = await setup(
    true,
    launchLifetimeSource.replace(
      '"installed:" + reason + "\\n");',
      '"installed:" + reason + "\\n");\n      throw new Error("installation callback failed");',
    ),
    undefined,
    {
      closeSession: async () => {
        closes++;
        if (rejectClose) throw new Error("provider close rejected");
      },
    },
  );
  try {
    await expect(h.create()).rejects.toThrow("provider close rejected");
    expect(closes).toBe(1);
    const agentId = h.launches[0]!.context!.agentId!;
    expect(h.daemon.daemon.agentManager.getAgent(agentId)?.lifecycle).toBe("idle");
    expect(await h.daemon.daemon.agentStorage.get(agentId)).toMatchObject({ lastStatus: "idle" });
    expect(await h.launches[0]!.context!.paseoTools!.executeTool("plugin_echo", {})).toMatchObject({
      content: [{ type: "text", text: "create:false" }],
    });
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\n",
    );
    rejectClose = false;
    await h.daemon.daemon.agentManager.closeAgent(agentId);
    expect(h.daemon.daemon.agentManager.getAgent(agentId)).toBeNull();
    expect(await h.daemon.daemon.agentStorage.get(agentId)).toMatchObject({ lastStatus: "closed" });
    expect(await readFile(path.join(h.directory, "launch-events"), "utf8")).toBe(
      "installed:create\ndisposed:create:true:true\n",
    );
  } finally {
    rejectClose = false;
    await h.close();
  }
}, 60_000);

async function setup(
  native = false,
  source = pluginSource,
  policy?: { enabled?: boolean; disabledTools?: string[] },
  providerOptions?: TestAgentClientOptions,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-tools-"));
  const recorder = recordingProvider(native, providerOptions);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.14.0-beta.1",
    agentClients: { codex: recorder.provider },
    mcpEnabled: true,
    providerOverrides: { codex: { paseoTools: policy } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  const mcps: Client[] = [];
  async function install(id: string, code: string) {
    const pluginDirectory = path.join(directory, id);
    await mkdir(pluginDirectory);
    await writeFile(
      path.join(pluginDirectory, "paseo-plugin.json"),
      JSON.stringify({ id, requirements: { paseo: ">=0.14.0-beta.1" } }),
    );
    await writeFile(path.join(pluginDirectory, "index.server.ts"), code);
    await client.installDirectoryPlugin(pluginDirectory);
  }
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  await client.patchDaemonConfig({ pluginsEnabled: true });
  try {
    await install("tools-test", source);
  } catch (error) {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...recorder,
    daemon,
    client,
    directory,
    install,
    async create(labels: Record<string, string> = {}) {
      return daemon.daemon.agentManager.createAgent(
        { provider: "codex", cwd: directory },
        undefined,
        { labels, initialTitle: "Chosen title" },
      );
    },
    async mcp(agentId?: string) {
      const server = recorder.launches.at(-1)!.config.mcpServers?.paseo;
      let url: string;
      if (agentId) url = `http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${agentId}`;
      else {
        if (server?.type !== "http") throw new Error("Expected HTTP server");
        url = server.url;
      }
      const mcp = new Client({ name: "plugin-tools-test", version: "1" });
      mcps.push(mcp);
      await mcp.connect(new StreamableHTTPClientTransport(new URL(url)));
      return mcp;
    },
    async close() {
      await Promise.all(mcps.map((mcp) => mcp.close()));
      await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("session hooks attach tools only to matching agents over MCP, with validated input and caller context", async () => {
  const h = await setup();
  try {
    const a = await h.create({ x: "y" });
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO)).toEqual({
      title: "Chosen title",
      labels: { x: "y" },
      reason: "create",
    });
    const mcpA = await h.mcp();
    const listed = (await mcpA.listTools()).tools.find((tool) => tool.name === "plugin_echo");
    expect(listed).toMatchObject({
      name: "plugin_echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, description: "Message" } },
        required: ["text"],
      },
    });
    const b = await h.create();
    const mcpB = await h.mcp();
    expect((await mcpB.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    const invalid = await mcpA.callTool({ name: "plugin_echo", arguments: { text: "" } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain("text");
    expect(
      await mcpA.callTool({ name: "plugin_echo", arguments: { text: "forbidden" } }),
    ).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Forbidden by plugin") }],
    });
    const result = await mcpA.callTool({ name: "plugin_echo", arguments: { text: "hello" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
      agent: { id: a.id, cwd: h.directory, title: "Chosen title" },
      input: { text: "hello" },
      calls: 1,
      sdk: "function",
      aborted: false,
    });
    expect(a.id).not.toBe(b.id);
    expect(
      await mcpA.callTool({ name: "plugin_echo", arguments: { text: "throw" } }),
    ).toMatchObject({ isError: true, content: [{ type: "text", text: "handler failed" }] });
    expect(
      (await mcpA.callTool({ name: "plugin_echo", arguments: { text: "still alive" } })).isError,
    ).not.toBe(true);
  } finally {
    await h.close();
  }
}, 60_000);

test("native providers get the same attached schema and execution", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const catalog = h.launches.at(-1)!.context!.paseoTools!;
    expect(catalog.getTool("plugin_echo")?.description).toBe("Echo for the chosen agent");
    const mcp = await h.mcp(a.id);
    const advertised = (await mcp.listTools()).tools.find((tool) => tool.name === "plugin_echo")!;
    expect(serializePaseoToolInputParameters(catalog.getTool("plugin_echo")!)).toEqual(
      advertised.inputSchema,
    );
    const result = await catalog.executeTool("plugin_echo", { text: "native" });
    expect(JSON.parse(result.content[0].text!)).toMatchObject({
      agent: { id: a.id },
      input: { text: "native" },
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("resume uses the stored title and labels, and close removes the attachment", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const catalog = h.launches.at(-1)!.context!.paseoTools!;
    const handle = a.persistence!;
    await h.daemon.daemon.agentManager.setTitle(a.id, "Stored title");
    await h.daemon.daemon.agentManager.closeAgent(a.id);
    expect(h.daemon.daemon.agentManager.getPluginTools(a.id)).toEqual([]);
    await expect(catalog.executeTool("plugin_echo", { text: "closed" })).rejects.toThrow(
      "Agent is not live",
    );
    await h.daemon.daemon.agentManager.resumeAgentFromPersistence(handle, a.config, a.id);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO)).toEqual({
      title: "Stored title",
      labels: { x: "y" },
      reason: "resume",
    });
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")?.name).toBe(
      "plugin_echo",
    );
  } finally {
    await h.close();
  }
}, 60_000);

test.each([
  {
    name: "Paseo",
    source: pluginSource.replace('name: "plugin_echo"', 'name: "list_agents"'),
    other: false,
    message: /plugin tools-test.*Paseo tool list_agents/,
  },
  {
    name: "another plugin",
    source: pluginSource,
    other: true,
    message: /plugin tools-test.*plugin other-tools/,
  },
  {
    name: "the same plugin",
    source: pluginSource.replace("tools: [...request.tools, tool]", "tools: [tool, tool]"),
    other: false,
    message: /Duplicate agent tool: plugin_echo/,
  },
])(
  "collisions with $name fail only targeted session opens",
  async ({ source, other, message }) => {
    const h = await setup(false, source);
    try {
      if (other) await h.install("other-tools", pluginSource);
      await expect(h.create({ x: "y" })).rejects.toThrow(message);
      expect(h.launches).toHaveLength(0);
      await h.create();
      expect(h.launches).toHaveLength(1);
      expect((await (await h.mcp()).listTools()).tools.map((tool) => tool.name)).not.toContain(
        "plugin_echo",
      );
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("each plugin owns its tool array and callbacks can remove earlier attachments", async () => {
  const source = pluginSource.replace(
    "  return () => {};",
    `
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.labels.x === "y" && request.tools[0]?.name !== "plugin_echo") throw new Error("Lost plugin-local definitions");
    return { ...request, tools: [] };
  });
  return () => {};`,
  );
  const h = await setup(false, source);
  try {
    await h.install(
      "other-tools",
      pluginSource
        .replace('name: "plugin_echo"', 'name: "other_echo"')
        .replace(
          '    if (request.labels.x !== "y") return;',
          '    if (request.tools.length !== 0) throw new Error("Saw another plugin tools");\n    if (request.labels.x !== "y") return;',
        ),
    );
    await h.create({ x: "y" });
    const names = (await (await h.mcp()).listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("other_echo");
    expect(names).not.toContain("plugin_echo");
  } finally {
    await h.close();
  }
}, 60_000);

test("disabled plugins remove tools from existing and new MCP catalogs", async () => {
  const h = await setup();
  try {
    await h.create({ x: "y" });
    const mcp = await h.mcp();
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    await h.client.patchDaemonConfig({ pluginsEnabled: false });
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    await h.create({ x: "y" });
    expect((await (await h.mcp()).listTools()).tools.map((tool) => tool.name)).not.toContain(
      "plugin_echo",
    );
  } finally {
    await h.close();
  }
}, 60_000);

test.each([false, true])(
  "provider tools disabled gates plugin tools (native=%s)",
  async (native) => {
    const h = await setup(native, pluginSource, { enabled: false });
    try {
      await h.create({ x: "y" });
      expect(h.launches.at(-1)!.context!.paseoTools).toBeUndefined();
      expect(h.launches.at(-1)!.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("disabledTools filters plugin tool names", async () => {
  const h = await setup(true, pluginSource, { disabledTools: ["plugin_echo"] });
  try {
    await h.create({ x: "y" });
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

const waitingSource = pluginSource
  .replace("import { z }", 'import { writeFile } from "node:fs/promises";\nimport { z }')
  .replace(
    "    calls++;",
    `
    calls++;
    if (input.text === "wait") {
      await writeFile(agent.cwd + "/started", agent.id);
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      await writeFile(agent.cwd + "/aborted", agent.id);
      return { text: "discard this result" };
    }
`,
  );

test("caller cancellation aborts the plugin handler and discards its result", async () => {
  const h = await setup(true, waitingSource);
  try {
    const a = await h.create({ x: "y" });
    const catalog = h.launches.at(-1)!.context!.paseoTools!;
    const controller = new AbortController();
    const call = catalog.executeTool(
      "plugin_echo",
      { text: "wait" },
      { signal: controller.signal },
    );
    const rejected = expect(call).rejects.toThrow("Canceled by caller");
    await expect.poll(() => readFile(path.join(h.directory, "started"), "utf8")).toBe(a.id);
    controller.abort(new Error("Canceled by caller"));
    await rejected;
    await expect.poll(() => readFile(path.join(h.directory, "aborted"), "utf8")).toBe(a.id);
  } finally {
    await h.close();
  }
}, 60_000);

test("a plugin stopping mid-call returns a tool error", async () => {
  const h = await setup(true, waitingSource);
  try {
    const a = await h.create({ x: "y" });
    const call = h.launches
      .at(-1)!
      .context!.paseoTools!.executeTool("plugin_echo", { text: "wait" });
    await expect.poll(() => readFile(path.join(h.directory, "started"), "utf8")).toBe(a.id);
    await h.client.patchDaemonConfig({ pluginsEnabled: false });
    expect(await call).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Plugin stopped") }],
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("history sessions ignore attached tools", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const handle = a.persistence!;
    await h.client.archiveAgent(a.id);
    await h.daemon.daemon.agentManager.resumeAgentFromPersistence(handle, a.config, a.id);
    expect(h.daemon.daemon.agentManager.getPluginTools(a.id)).toEqual([]);
    expect(h.launches.at(-1)!.context!.paseoTools?.getTool("plugin_echo")).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("disabled plugins attach no tools to a new native session", async () => {
  const h = await setup(true);
  try {
    await h.client.patchDaemonConfig({ pluginsEnabled: false });
    await h.create({ x: "y" });
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("structured tool results get model-visible text when text is omitted", async () => {
  const h = await setup(
    true,
    pluginSource.replace(
      "    calls++;",
      '    return { structuredContent: { status: "created" } };',
    ),
  );
  try {
    await h.create({ x: "y" });
    expect(
      await h.launches
        .at(-1)!
        .context!.paseoTools!.executeTool("plugin_echo", { text: "structured" }),
    ).toEqual({
      content: [{ type: "text", text: JSON.stringify({ status: "created" }, null, 2) }],
      structuredContent: { status: "created" },
      isError: undefined,
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("reloading a plugin retires its old attachments before an agent reopens", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const mcp = await h.mcp(a.id);
    const oldCatalog = h.launches.at(-1)!.context!.paseoTools!;
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    await h.client.reloadPlugin("tools-test");
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    expect(h.daemon.daemon.agentManager.getPluginTools(a.id)).toEqual([]);
    expect(await oldCatalog.executeTool("plugin_echo", { text: "retired" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("not available") }],
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("built-in plugins attach and execute tools while configured plugins are disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-builtin-tools-"));
  const directory = path.join(root, "builtin-tools");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "builtin-tools", requirements: { paseo: ">=0.14.0-beta.1" } }),
  );
  await writeFile(path.join(directory, "index.server.ts"), pluginSource);
  const recorder = recordingProvider(true);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.14.0-beta.1",
    agentClients: { codex: recorder.provider },
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["builtin-tools"]),
  });
  try {
    const a = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: root },
      undefined,
      { labels: { x: "y" } },
    );
    const catalog = recorder.launches.at(-1)!.context!.paseoTools!;
    expect(catalog.getTool("plugin_echo")?.name).toBe("plugin_echo");
    const result = await catalog.executeTool("plugin_echo", { text: "builtin" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text!)).toMatchObject({
      agent: { id: a.id },
      input: { text: "builtin" },
    });
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a session hook missing tools reports a schema issue", async () => {
  const h = await setup(
    false,
    pluginSource.replace("tools: [...request.tools, tool]", "tools: undefined"),
  );
  try {
    await expect(h.create({ x: "y" })).rejects.toThrow('"tools"');
  } finally {
    await h.close();
  }
}, 60_000);

async function sendAndFinish(h: Awaited<ReturnType<typeof setup>>, agentId: string, text: string) {
  const previous = h.turns.length;
  await h.client.sendMessage(agentId, text, { activeTurnBehavior: "steer" });
  await expect.poll(() => h.turns.length).toBe(previous + 1);
  await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(agentId)).toBe(false);
}

test("an idle agent reopens once before its next prompt after a session-hook plugin reload", async () => {
  const h = await setup();
  try {
    const b = await h.create();
    const mcp = await h.mcp();
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    await writeFile(
      path.join(h.directory, "tools-test", "index.server.ts"),
      pluginSource.replace('    if (request.labels.x !== "y") return;', ""),
    );
    await h.client.reloadPlugin("tools-test");
    expect(h.launches).toHaveLength(1);
    await sendAndFinish(h, b.id, "first prompt");
    expect(h.launches).toHaveLength(2);
    expect(h.turns.map((turn) => turn.launchCount)).toEqual([2]);
    await expect(mcp.listTools()).rejects.toThrow("Error POSTing to endpoint");
    const replacementMcp = await h.mcp();
    expect((await replacementMcp.listTools()).tools.map((tool) => tool.name)).toContain(
      "plugin_echo",
    );
    const legacyMcp = await h.mcp(b.id);
    expect((await legacyMcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    await sendAndFinish(h, b.id, "second prompt");
    expect(h.launches).toHaveLength(2);
    expect(h.turns.map((turn) => turn.launchCount)).toEqual([2, 2]);
    expect(h.events.interrupts).toBe(0);
  } finally {
    await h.close();
  }
}, 60_000);

test("a busy agent is steered after plugin reload and reopens only at its next idle prompt", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(true, pluginSource, undefined, { beforeTurnComplete: async () => blocked });
  try {
    const a = await h.create({ x: "y" });
    await h.client.sendMessage(a.id, "busy prompt", { activeTurnBehavior: "steer" });
    await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(a.id)).toBe(true);
    await expect
      .poll(() => h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId)
      .not.toBeNull();
    const turnId = h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId;
    await h.client.reloadPlugin("tools-test");
    await h.client.sendMessage(a.id, "steering prompt", { activeTurnBehavior: "steer" });
    expect(h.steers).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
    expect(h.events.interrupts).toBe(0);
    expect(h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId).toBe(turnId);
    release();
    await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(a.id)).toBe(false);
    await sendAndFinish(h, a.id, "idle prompt");
    expect(h.launches).toHaveLength(2);
    expect(h.events.interrupts).toBe(0);
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")?.name).toBe(
      "plugin_echo",
    );
    await sendAndFinish(h, a.id, "stable prompt");
    expect(h.launches).toHaveLength(2);
  } finally {
    release();
    await h.close();
  }
}, 60_000);

const reloadRpcSource = pluginSource
  .replace("import { z }", 'import { defineRpc } from "@getpaseo/plugin";\nimport { z }')
  .replace(
    "  return () => {};",
    `
  server.handle(defineRpc({ name: "reload_agent", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) }), async ({ id }, { paseo }) => {
    const agent = paseo.agents.ref(id);
    await agent.refresh();
    await agent.reload();
    return { id: agent.current().id };
  });
  return () => {};
`,
  );

test("a plugin can reload an agent through the SDK and rerun session hooks with reason refresh", async () => {
  const h = await setup(true, reloadRpcSource);
  try {
    const a = await h.create({ x: "y" });
    expect(h.launches).toHaveLength(1);
    expect(await h.client.invokePluginRpc("tools-test", "reload_agent", { id: a.id })).toEqual({
      id: a.id,
    });
    expect(h.launches).toHaveLength(2);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("refresh");
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")?.name).toBe(
      "plugin_echo",
    );
  } finally {
    await h.close();
  }
}, 60_000);

test("starting and stopping a session-hook plugin each causes one idle reopen", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    await h.install(
      "added-tools",
      pluginSource.replace('name: "plugin_echo"', 'name: "added_echo"'),
    );
    await sendAndFinish(h, a.id, "after start");
    expect(h.launches).toHaveLength(2);
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("added_echo")?.name).toBe("added_echo");
    await h.client.disablePlugin("added-tools");
    await sendAndFinish(h, a.id, "after stop");
    expect(h.launches).toHaveLength(3);
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("added_echo")).toBeUndefined();
    await sendAndFinish(h, a.id, "stable after stop");
    expect(h.launches).toHaveLength(3);
    expect(h.events.interrupts).toBe(0);
  } finally {
    await h.close();
  }
}, 60_000);

test("plugins without a session-open hook do not make agent sessions stale", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    await h.install(
      "no-session-hook",
      "export default function contribute(server) { server.on('agent.created', () => {}); return () => {}; }",
    );
    await sendAndFinish(h, a.id, "after unrelated start");
    expect(h.launches).toHaveLength(1);
    await h.client.reloadPlugin("no-session-hook");
    await sendAndFinish(h, a.id, "after unrelated reload");
    expect(h.launches).toHaveLength(1);
    await h.client.disablePlugin("no-session-hook");
    await sendAndFinish(h, a.id, "after unrelated stop");
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

test("explicit SDK reload interrupts a running turn before reopening its session", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(true, reloadRpcSource, undefined, {
    beforeTurnComplete: async () => blocked,
    onInterrupt: () => release(),
  });
  try {
    const a = await h.create({ x: "y" });
    await h.client.sendMessage(a.id, "running before explicit reload", {
      activeTurnBehavior: "steer",
    });
    await expect
      .poll(() => h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId)
      .not.toBeNull();
    expect(await h.client.invokePluginRpc("tools-test", "reload_agent", { id: a.id })).toEqual({
      id: a.id,
    });
    expect(h.events.interrupts).toBe(1);
    expect(h.launches).toHaveLength(2);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("refresh");
  } finally {
    release();
    await h.close();
  }
}, 60_000);

test("the agent-tools example appends notes only for labeled agents", async () => {
  const h = await setup();
  try {
    await h.client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/agent-tools", import.meta.url)),
    );
    const a = await h.create({ "notes/enabled": "true" });
    const mcpA = await h.mcp(a.id);
    expect((await mcpA.listTools()).tools.map((tool) => tool.name)).toContain(
      "append_workspace_note",
    );
    expect(
      await mcpA.callTool({
        name: "append_workspace_note",
        arguments: { note: "Run the targeted tests before committing." },
      }),
    ).toMatchObject({
      content: [
        { type: "text", text: `Saved note to ${path.join(h.directory, "AGENT_NOTES.md")}` },
      ],
      structuredContent: { path: path.join(h.directory, "AGENT_NOTES.md") },
    });
    expect(await readFile(path.join(h.directory, "AGENT_NOTES.md"), "utf8")).toBe(
      "Run the targeted tests before committing.\n",
    );
    await mcpA.callTool({
      name: "append_workspace_note",
      arguments: { note: "Keep existing notes." },
    });
    expect(await readFile(path.join(h.directory, "AGENT_NOTES.md"), "utf8")).toBe(
      "Run the targeted tests before committing.\nKeep existing notes.\n",
    );
    await h.create();
    const mcpB = await h.mcp();
    expect((await mcpB.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "append_workspace_note",
    );
  } finally {
    await h.close();
  }
}, 60_000);

const companyServer = { type: "http", url: "https://tools.example.com/mcp" } as const;
const mcpSource = `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.provider !== "codex") return;
    return { ...request, mcpServers: { ...request.mcpServers, company: ${JSON.stringify(companyServer)} },
      env: { ...request.env, OPEN_REASON: request.reason } };
  });
  return () => {};
}
`;

test.each([
  { native: false, serverNames: ["paseo", "company"] },
  { native: true, serverNames: ["company"] },
])(
  "session-open MCP servers reach launch but never saved configuration (native=$native)",
  async ({ native, serverNames }) => {
    const h = await setup(native, mcpSource);
    try {
      const a = await h.create();
      expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
      expect(a.config.mcpServers?.company).toBeUndefined();
      const snapshot = (await h.client.fetchAgent(a.id))!.agent;
      expect(snapshot.id).toBe(a.id);
      expect(JSON.stringify(snapshot)).not.toContain("tools.example.com");
      expect(h.launches.at(-1)!.context!.env!.OPEN_REASON).toBe("create");
      expect(Object.keys(h.launches.at(-1)!.config.mcpServers!)).toEqual(serverNames);
      await h.daemon.daemon.agentManager.closeAgent(a.id);
      const agentFiles = await readdir(path.join(h.daemon.paseoHome, "agents"), {
        recursive: true,
      });
      const recordFile = agentFiles.find((file) => file.endsWith(a.id + ".json"))!;
      const record = await readFile(path.join(h.daemon.paseoHome, "agents", recordFile), "utf8");
      expect(record).not.toContain("tools.example.com");
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("session-open MCP servers are rederived on resume, SDK reload, and provider import", async () => {
  const source = reloadRpcSource
    .replace('    if (request.labels.x !== "y") return;', "")
    .replace(
      "return { ...request, env:",
      `return { ...request, mcpServers: { ...request.mcpServers, company: ${JSON.stringify(companyServer)} }, env:`,
    );
  const h = await setup(true, source);
  try {
    const a = await h.create({ x: "y" });
    const manager = h.daemon.daemon.agentManager;
    await manager.closeAgent(a.id);
    await manager.resumeAgentFromPersistence(a.persistence!, a.config, a.id);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("resume");
    await h.client.invokePluginRpc("tools-test", "reload_agent", { id: a.id });
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("refresh");
    const imported = await manager.importProviderSession({
      provider: "codex",
      providerHandleId: "imported-session",
      cwd: h.directory,
      workspaceId: "import-workspace",
      labels: { x: "y" },
    });
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("import");
    expect(imported.config.mcpServers?.company).toBeUndefined();
    expect(JSON.stringify(imported.persistence)).not.toContain("tools.example.com");
    expect(manager.getAgent(a.id)!.config.mcpServers?.company).toBeUndefined();
    expect(JSON.stringify(manager.getAgent(a.id)!.persistence)).not.toContain("tools.example.com");
  } finally {
    await h.close();
  }
}, 60_000);

test("installing and disabling an MCP plugin reopens idle sessions before their next prompt", async () => {
  const h = await setup(true, "export default function contribute() { return () => {}; }");
  try {
    const a = await h.create();
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
    await h.install("company-mcp", mcpSource);
    await sendAndFinish(h, a.id, "after install");
    expect(h.launches).toHaveLength(2);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    await h.client.disablePlugin("company-mcp");
    await sendAndFinish(h, a.id, "after disable");
    expect(h.launches).toHaveLength(3);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
    await sendAndFinish(h, a.id, "stable");
    expect(h.launches).toHaveLength(3);
    expect(h.events.interrupts).toBe(0);
  } finally {
    await h.close();
  }
}, 60_000);

test("installing and disabling an MCP plugin never interrupts a running turn", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(
    true,
    "export default function contribute() { return () => {}; }",
    undefined,
    { beforeTurnComplete: async () => blocked },
  );
  try {
    const a = await h.create();
    await h.client.sendMessage(a.id, "busy", { activeTurnBehavior: "steer" });
    const manager = h.daemon.daemon.agentManager;
    await expect.poll(() => manager.getAgent(a.id)!.activeTurnId).not.toBeNull();
    const turn = manager.getAgent(a.id)!.activeTurnId;
    await h.install("company-mcp", mcpSource);
    expect(h.launches).toHaveLength(1);
    expect(manager.getAgent(a.id)!.activeTurnId).toBe(turn);
    await h.client.disablePlugin("company-mcp");
    expect(h.launches).toHaveLength(1);
    expect(manager.getAgent(a.id)!.activeTurnId).toBe(turn);
    expect(h.events.interrupts).toBe(0);
    release();
    await expect.poll(() => manager.hasInFlightRun(a.id)).toBe(false);
    await sendAndFinish(h, a.id, "idle");
    expect(h.launches).toHaveLength(2);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
  } finally {
    release();
    await h.close();
  }
}, 60_000);

test.each([
  {
    target: "saved configuration",
    saved: true,
    name: "company",
    other: false,
    error: /company.*plugin tools-test.*agent saved configuration/,
  },
  {
    target: "saved Paseo name",
    saved: true,
    name: "paseo",
    other: false,
    error: /paseo.*plugin tools-test.*agent saved configuration/,
  },
  {
    target: "Paseo internal server",
    saved: false,
    name: "paseo",
    other: false,
    error: /paseo.*plugin tools-test.*Paseo internal MCP server/,
  },
  {
    target: "another plugin with identical config",
    saved: false,
    name: "company",
    other: true,
    error: /Plugin tools-test.*company.*plugin other-mcp/,
  },
])(
  "session-open MCP collisions with $target name both owners",
  async ({ saved, name, other, error }) => {
    const h = await setup(true, mcpSource.replace("company:", name + ":"));
    try {
      if (other) await h.install("other-mcp", mcpSource);
      await expect(
        h.daemon.daemon.agentManager.createAgent(
          {
            provider: "codex",
            cwd: h.directory,
            ...(saved
              ? { mcpServers: { [name]: { type: "http", url: "https://saved.example.com" } } }
              : {}),
          },
          undefined,
          {},
        ),
      ).rejects.toThrow(error);
      expect(h.launches).toHaveLength(0);
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("session-open MCP servers fail on unsupported providers and leave saved config untouched", async () => {
  const h = await setup(false, mcpSource, undefined, { supportsMcpServers: false });
  try {
    await h.client.disablePlugin("tools-test");
    const a = await h.create();
    await h.client.enablePlugin("tools-test");
    await expect(h.daemon.daemon.agentManager.reloadAgentSession(a.id)).rejects.toThrow(
      /does not support MCP servers.*plugin tools-test/,
    );
    expect(a.config.mcpServers?.company).toBeUndefined();
    await expect(h.create()).rejects.toThrow(/does not support MCP servers.*plugin tools-test/);
    const imported = h.daemon.daemon.agentManager.importProviderSession({
      provider: "codex",
      providerHandleId: "unsupported-import",
      cwd: h.directory,
      workspaceId: "import-workspace",
    });
    await expect(imported).rejects.toThrow(/does not support MCP servers.*plugin tools-test/);
  } finally {
    await h.close();
  }
}, 60_000);

test("history opens ignore session-open MCP servers", async () => {
  const h = await setup(true, mcpSource);
  try {
    const a = await h.create();
    await h.client.archiveAgent(a.id);
    await h.install("other-mcp", mcpSource);
    await h.daemon.daemon.agentManager.resumeAgentFromPersistence(a.persistence!, a.config, a.id);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
    expect(h.launches.at(-1)!.context!.mcpServers).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("session-open MCP maps are plugin-local and accumulate only across their own callbacks", async () => {
  const h = await setup(true, mcpSource);
  try {
    await h.install(
      "z-extend",
      `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if ("mcpServerOwners" in request) throw new Error("Daemon provenance leaked");
    if (Object.keys(request.mcpServers).length !== 0) throw new Error("Saw another plugin servers");
    return { ...request, mcpServers: { ...request.mcpServers, extra: { type: "stdio", command: "company-tools", args: ["--mcp"], env: { MODE: "agent" } } } };
  });
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.mcpServers.extra.command !== "company-tools") throw new Error("Lost own earlier server");
    return { ...request, mcpServers: { ...request.mcpServers, additional: { type: "http", url: "https://additional.example.com/mcp" } } };
  });
  server.addHook("agent.open.before", async () => undefined);
  return () => {};
}`,
    );
    const a = await h.create();
    expect(h.launches.at(-1)!.config.mcpServers).toEqual({
      company: companyServer,
      extra: { type: "stdio", command: "company-tools", args: ["--mcp"], env: { MODE: "agent" } },
      additional: { type: "http", url: "https://additional.example.com/mcp" },
    });
    const contributedServers = h.launches.at(-1)!.config.mcpServers;
    await h.install(
      "zz-remove",
      `export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, mcpServers: {} }));
  return () => {};
}`,
    );
    await sendAndFinish(h, a.id, "after removal");
    expect(h.launches.at(-1)!.config.mcpServers).toEqual(contributedServers);
    expect(a.config.mcpServers).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("session-open MCP configs are validated before a provider launches", async () => {
  const h = await setup(
    true,
    mcpSource.replace(JSON.stringify(companyServer), '{ type: "http", url: 42 }'),
  );
  try {
    await expect(h.create()).rejects.toThrow(/Plugin tools-test.*agent.open.before/s);
    expect(h.launches).toHaveLength(0);
  } finally {
    await h.close();
  }
}, 60_000);
