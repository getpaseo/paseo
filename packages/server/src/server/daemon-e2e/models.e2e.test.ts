import { describe, test, expect } from "vitest";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { execFileSync } from "node:child_process";
import { createDaemonTestContext } from "../test-utils/index.js";

function isBinaryInstalled(binary: string): boolean {
  try {
    const out = execFileSync("which", [binary], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

const hasCodex = isBinaryInstalled("codex");
const hasOpenCode = isBinaryInstalled("opencode");

describe("daemon E2E", () => {
  describe("listProviderModels", () => {
    test.runIf(hasCodex)(
      "returns model list for Codex provider",
      async () => {
        const ctx = await createDaemonTestContext();
        try {
          // List models for Codex provider - no agent needed
          const result = await ctx.client.listProviderModels("codex");

          // Verify response structure
          expect(result.provider).toBe("codex");
          expect(result.error).toBeNull();
          expect(result.fetchedAt).toBeTruthy();

          // Should return at least one model
          expect(result.models).toBeTruthy();
          expect(result.models.length).toBeGreaterThan(0);

          // Verify model structure
          const model = result.models[0];
          expect(model.provider).toBe("codex");
          expect(model.id).toBeTruthy();
          expect(model.label).toBeTruthy();
        } finally {
          await ctx.cleanup();
        }
      },
      60000, // 1 minute timeout
    );

    test("returns model list for Claude provider", async () => {
      const ctx = await createDaemonTestContext();
      try {
        // List models for Claude provider - no agent needed
        const result = await ctx.client.listProviderModels("claude");

        // Verify response structure
        expect(result.provider).toBe("claude");
        expect(result.error).toBeNull();
        expect(result.fetchedAt).toBeTruthy();

        // Should return at least one model
        expect(result.models).toBeTruthy();
        expect(result.models.length).toBeGreaterThan(0);

        // Verify model structure
        const model = result.models[0];
        expect(model.provider).toBe("claude");
        expect(model.id).toBeTruthy();
        expect(model.label).toBeTruthy();
      } finally {
        await ctx.cleanup();
      }
    }, 180000);

    test.runIf(hasOpenCode)(
      "returns model list for OpenCode provider",
      async () => {
        const ctx = await createDaemonTestContext();
        try {
          const result = await ctx.client.listProviderModels("opencode");

          expect(result.provider).toBe("opencode");
          expect(result.error).toBeNull();
          expect(result.fetchedAt).toBeTruthy();

          expect(result.models).toBeTruthy();
          expect(result.models.length).toBeGreaterThan(0);

          const model = result.models[0];
          expect(model.provider).toBe("opencode");
          expect(model.id).toBeTruthy();
          expect(model.label).toBeTruthy();
        } finally {
          await ctx.cleanup();
        }
      },
      60000,
    );
  });
});

test("Antigravity creates an agent and answers a prompt with real agy", async ({ skip }) => {
  const command = await findExecutable(process.env.AGY_COMMAND ?? "agy");
  if (command === null) {
    skip("agy is not resolvable");
    return;
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-antigravity-e2e-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: {},
    mcpEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(undefined, ["antigravity-provider"]),
    providerOverrides: { antigravity: { command: [command], paseoTools: { enabled: false } } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.10.0",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    // Snapshot reads start discovery again; await one refresh before checking readiness.
    await client.refreshProvidersSnapshot({ cwd, providers: ["antigravity"] });
    const snapshot = await client.getProvidersSnapshot({ cwd });
    expect(snapshot.entries.find((entry) => entry.provider === "antigravity")?.status).toBe(
      "ready",
    );
    const agent = await client.createAgent({
      provider: "antigravity",
      cwd,
      title: "Antigravity E2E",
    });
    expect(agent.currentModeId).toBe("full-access");
    expect(agent.availableModes?.map((mode) => mode.id)).toEqual(["full-access"]);
    const openedTimeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
    expect(openedTimeline.entries.map((entry) => entry.item)).toEqual([
      {
        type: "notification",
        level: "warning",
        message:
          "Antigravity is running with full access\nAntigravity's CLI cannot ask for permission when another app drives it, so Paseo starts it with --dangerously-skip-permissions. Every tool call, including shell commands, runs without asking.",
      },
    ]);
    await client.sendMessage(agent.id, "Reply with exactly ANTIGRAVITY_E2E_OK. No tools.");
    const result = await client.waitForFinish(agent.id, 90000);
    expect(result.status).toBe("idle");
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
    expect(
      timeline.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("ANTIGRAVITY_E2E_OK"),
      ),
    ).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);

test("Antigravity replays its stored conversation into the timeline after a daemon restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-antigravity-replay-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  // The fake CLI replays a fixed ACP history and answers session/load mid-stream, as agy can.
  const fake = path.resolve(
    import.meta.dirname,
    "../../../../../plugins/antigravity-provider/test/agy.mjs",
  );
  const options = {
    paseoHomeRoot: path.join(root, "home"),
    cleanup: false,
    agentClients: {},
    mcpEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(undefined, ["antigravity-provider"]),
    providerOverrides: {
      antigravity: { command: [process.execPath, fake], paseoTools: { enabled: false } },
    },
  };
  let daemon = await createTestPaseoDaemon(options);
  const connect = async () => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.16.0",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  };
  let client = await connect();
  try {
    const agent = await client.createAgent({ provider: "antigravity", cwd });
    await client.sendMessage(agent.id, "HELLO");
    expect((await client.waitForFinish(agent.id, 30000)).status).toBe("idle");
    await client.close();
    await daemon.close();
    // The restarted daemon has no timeline for the agent; loading it replays provider history.
    daemon = await createTestPaseoDaemon({ ...options, staticDir: daemon.staticDir });
    client = await connect();

    const timeline = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 200 });
    const messages = timeline.entries.flatMap(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message"
        ? [{ type: item.type, text: item.text }]
        : [],
    );
    // The fixture's first prompt carries a system prefix this daemon did not send, so it stays.
    expect(messages).toEqual([
      { type: "user_message", text: "SYSTEM PREFIX\n\nList the files." },
      { type: "assistant_message", text: "There is one file, README.md." },
      { type: "user_message", text: "Edit it. Then stop." },
      { type: "assistant_message", text: "Done." },
    ]);
    expect(timeline.entries.map(({ item }) => item.type)).toEqual([
      "user_message",
      "reasoning",
      "tool_call",
      "tool_call",
      "reasoning",
      "assistant_message",
      "user_message",
      "tool_call",
      "tool_call",
      "tool_call",
      "assistant_message",
      "notification",
    ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("bundled fx requires a config entry and lists models instead of its providers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-fx-optin-"));
  const record = path.join(root, "launches.txt");
  await writeFile(record, "");
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    mcpEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(undefined, ["fx-provider"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.15.3",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    expect(client.getLastServerInfoMessage()?.features?.fxProvider).toBe(true);
    const before = await client.getProvidersSnapshot();
    expect(before.entries.some((entry) => entry.provider === "fx")).toBe(false);
    expect(await readFile(record, "utf8")).toBe("");

    await client.patchDaemonConfig({
      providers: {
        fx: {
          enabled: true,
          command: [process.execPath, path.resolve(import.meta.dirname, "fx-fixture.cjs")],
          env: { FX_TEST_RECORD: record },
        },
      },
    });
    const { models } = await client.listProviderModels("fx", { cwd: root });
    expect(models.map((model) => model.id)).toEqual(["fixture-small", "fixture-large"]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("bundled Hoplite requires a config entry and removal survives restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-hoplite-optin-"));
  const record = path.join(root, "launches.txt");
  await writeFile(record, "");
  const options = {
    paseoHomeRoot: root,
    cleanup: false,
    mcpEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(undefined, [
      "hoplite-provider",
      "antigravity-provider",
    ]),
  };
  let daemon = await createTestPaseoDaemon(options);
  const connect = async () => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.11.2",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  };
  let client = await connect();
  try {
    const before = await client.getProvidersSnapshot();
    expect(before.entries.some((entry) => entry.provider === "hoplite")).toBe(false);
    expect(before.entries.some((entry) => entry.provider === "antigravity")).toBe(true);
    expect(await readFile(record, "utf8")).toBe("");

    await client.patchDaemonConfig({
      providers: {
        hoplite: {
          enabled: true,
          command: [process.execPath, path.resolve(import.meta.dirname, "hoplite-fixture.cjs")],
          env: { HOPLITE_TEST_RECORD: record, HOPLITE_TEST_CWD: root },
        },
      },
    });
    const globalModels = await client.listProviderModels("hoplite");
    expect(globalModels.error).toBeNull();
    expect(globalModels.models).toEqual([]);
    await expect
      .poll(
        async () =>
          (await client.getProvidersSnapshot()).entries.find(
            (entry) => entry.provider === "hoplite",
          )?.status,
      )
      .toBe("ready");
    const workspaceModels = await client.listProviderModels("hoplite", { cwd: root });
    expect(workspaceModels.error).toBeNull();
    expect(workspaceModels.models.map((model) => model.id)).toEqual(["fixture-model"]);
    await client.refreshProvidersSnapshot({ providers: ["hoplite"] });
    expect((await client.listProviderModels("hoplite")).models).toEqual([]);
    expect(
      (await client.listProviderModels("hoplite", { cwd: root })).models.map((model) => model.id),
    ).toEqual(["fixture-model"]);
    const agent = await client.createAgent({
      provider: "hoplite",
      cwd: root,
      model: "fixture-model",
    });
    await client.sendMessage(agent.id, "Exercise the contributor transformer");
    await client.waitForFinish(agent.id, 10000);
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
    expect(timeline.entries.map((entry) => entry.item)).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        name: "Hoplite workspace",
        status: "completed",
      }),
    );
    await client.archiveAgent(agent.id);
    expect(await readFile(record, "utf8")).toContain("launch");

    await client.patchDaemonConfig({ providers: { hoplite: { enabled: false } } });
    expect(
      (await client.getProvidersSnapshot()).entries.find((entry) => entry.provider === "hoplite")
        ?.enabled,
    ).toBe(false);
    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon({
      ...options,
      staticDir: daemon.staticDir,
      providerOverrides: loadConfig(daemon.paseoHome, { env: {} }).providerOverrides,
    });
    client = await connect();
    expect(
      (await client.getProvidersSnapshot()).entries.find((entry) => entry.provider === "hoplite")
        ?.enabled,
    ).toBe(false);
    await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
    expect(
      (await client.getProvidersSnapshot()).entries.some((entry) => entry.provider === "hoplite"),
    ).toBe(false);
    expect((await client.getDaemonConfig()).config.providers?.hoplite).toBeUndefined();
    const persisted = JSON.parse(
      await readFile(path.join(daemon.paseoHome, "config.json"), "utf8"),
    );
    expect(persisted.agents?.providers?.hoplite).toBeUndefined();
    const launchesAfterRemoval = await readFile(record, "utf8");
    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon({
      ...options,
      staticDir: daemon.staticDir,
      providerOverrides: loadConfig(daemon.paseoHome, { env: {} }).providerOverrides,
    });
    client = await connect();
    const restarted = await client.getProvidersSnapshot();
    expect(restarted.entries.some((entry) => entry.provider === "hoplite")).toBe(false);
    expect(restarted.entries.map((entry) => entry.provider)).toEqual(
      before.entries.map((entry) => entry.provider),
    );
    expect(await readFile(record, "utf8")).toBe(launchesAfterRemoval);
    await client.patchDaemonConfig({ providers: { hoplite: { enabled: false } } });
    expect(
      (await client.getProvidersSnapshot()).entries.find((entry) => entry.provider === "hoplite")
        ?.enabled,
    ).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
    await rm(daemon.staticDir, { recursive: true, force: true });
  }
}, 60000);
