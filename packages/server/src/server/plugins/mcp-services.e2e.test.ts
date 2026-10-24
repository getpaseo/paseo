import { loadConfig } from "../config.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import pino from "pino";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";

test("plugin service registration updates direct provider config while ordinary RPC stays independent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-mcp-services-"));
  const launches: AgentSessionConfig[] = [];
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.13.0-beta.1",
    mcpEnabled: false,
    agentClients: {
      claude: createTestAgentClient("claude", { supportsMcpServers: false }),
      codex: createTestAgentClient("codex", {
        supportsMcpServers: true,
        beforeCreateSession: async (config) => {
          launches.push(config);
        },
      }),
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.13.0-beta.1",
  });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "repository-service", requirements: { paseo: ">=0.13.0-beta.1" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
      import { z } from "zod";
      export default function contribute(server) {
        const service = server.registerMcpServer({ id: "repositories", label: "Fictional repositories", config: { type: "http", url: "https://first.example/mcp", headers: { authorization: "fictional-private-secret" } } });
        server.handle({ name: "configure", input: z.object({ url: z.string().nullable() }), output: z.null() }, ({ url }) => { service.update(url ? { type: "http", url } : null); return null; });
        server.handle({ name: "crash", input: z.object({}), output: z.null() }, () => process.exit(1));
        server.handle({ name: "remove", input: z.object({}), output: z.null() }, () => { service.remove(); return null; });
        server.handle({ name: "duplicate", input: z.object({}), output: z.null() }, () => { server.registerMcpServer({ id: "another", label: "Duplicate", config: null }); return null; });
        server.handle({ name: "repositories", input: z.object({}), output: z.array(z.string()) }, () => ["orchard", "harbor"]);
        return () => service.remove();
      }
    `,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const catalog = await client.listPlugins();
    expect(catalog.find((plugin) => plugin.id === "repository-service")?.mcpServer).toEqual({
      id: "repositories",
      label: "Fictional repositories",
      transport: "http",
      configured: true,
    });
    expect(JSON.stringify(catalog)).not.toContain("fictional-private-secret");
    await expect(client.invokePluginRpc("repository-service", "duplicate", {})).rejects.toThrow(
      "MCP_ALREADY_REGISTERED",
    );
    expect(await client.invokePluginRpc("repository-service", "repositories", {})).toEqual([
      "orchard",
      "harbor",
    ]);
    await client.fetchAgents({ subscribe: {} });
    const manual = { type: "http" as const, url: "https://manual.example/mcp" };
    const agent = await client.createAgent({
      provider: "codex",
      cwd: directory,
      mcpServers: { manual },
    });
    expect(launches[0].mcpServers).toEqual({
      manual,
      "plugin_repository-service_repositories": {
        type: "http",
        url: "https://first.example/mcp",
        headers: { authorization: "fictional-private-secret" },
      },
    });
    expect(JSON.stringify(agent)).not.toContain("fictional-private-secret");
    const managed = daemon.daemon.agentManager.getAgent(agent.id);
    expect(JSON.stringify(managed?.config)).not.toContain("fictional-private-secret");
    expect(JSON.stringify(managed?.persistence)).not.toContain("fictional-private-secret");
    await expect(client.createAgent({ provider: "claude", cwd: directory })).rejects.toThrow(
      "does not support MCP servers",
    );
    await expect(
      client.createAgent({
        provider: "codex",
        cwd: directory,
        mcpServers: { "plugin_repository-service_repositories": manual },
      }),
    ).rejects.toThrow("conflicts");
    const metadataEvents: unknown[] = [];
    const observation = client.observeEvents(["status.plugin_catalog_changed"]);
    await observation.ready;
    client.on("status", (message) => {
      if (message.payload.status === "plugin_catalog_changed") metadataEvents.push(message.payload);
    });
    await client.invokePluginRpc("repository-service", "configure", {
      url: "https://second.example/mcp",
    });
    await expect
      .poll(() => metadataEvents)
      .toContainEqual(
        expect.objectContaining({
          status: "plugin_catalog_changed",
          pluginId: "repository-service",
          reason: "mcp",
        }),
      );
    await observation.release();
    const second = await client.createAgent({ provider: "codex", cwd: directory });
    expect(launches[1].mcpServers?.["plugin_repository-service_repositories"]).toEqual({
      type: "http",
      url: "https://second.example/mcp",
    });
    await client.invokePluginRpc("repository-service", "configure", { url: null });
    expect(
      (await client.listPlugins()).find((plugin) => plugin.id === "repository-service")?.mcpServer,
    ).toMatchObject({ configured: false, transport: null });
    await client.invokePluginRpc("repository-service", "remove", {});
    const next = await client.createAgent({ provider: "codex", cwd: directory });
    expect(launches[2].mcpServers).toBeUndefined();
    expect(await client.invokePluginRpc("repository-service", "repositories", {})).toEqual([
      "orchard",
      "harbor",
    ]);
    await client.reloadPlugin("repository-service");
    expect(
      (await client.listPlugins()).find((plugin) => plugin.id === "repository-service")?.mcpServer,
    ).toMatchObject({ configured: true });
    await client.disablePlugin("repository-service");
    expect(
      (await client.listPlugins()).find((plugin) => plugin.id === "repository-service")?.mcpServer,
    ).toBeUndefined();
    const disabled = await client.createAgent({ provider: "codex", cwd: directory });
    expect(launches[3].mcpServers).toBeUndefined();
    await client.enablePlugin("repository-service");
    expect(
      (await client.listPlugins()).find((plugin) => plugin.id === "repository-service")?.mcpServer,
    ).toMatchObject({ configured: true });
    await expect(client.invokePluginRpc("repository-service", "crash", {})).rejects.toThrow();
    await expect
      .poll(
        async () =>
          (await client.listPlugins()).find((plugin) => plugin.id === "repository-service")?.status,
      )
      .toBe("failed");
    expect(
      (await client.listPlugins()).find((plugin) => plugin.id === "repository-service")?.mcpServer,
    ).toBeUndefined();
    await client.removePlugin("repository-service");
    expect(await client.listPlugins()).toEqual([]);
    await client.archiveAgent(disabled.id);
    await client.archiveAgent(agent.id);
    await client.archiveAgent(second.id);
    await client.archiveAgent(next.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the formal example shares fictional business behavior between ordinary UI RPC and its MCP service", async () => {
  const demo = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../../../plugin-examples/repository-mcp/server/demo.mjs", import.meta.url),
      ),
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(demo, "exit");
  const ready = new Promise<string>((resolve, reject) => {
    let output = "";
    demo.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = /Fictional MCP: (http:\/\/[^\s]+)/.exec(output);
      if (match) resolve(match[1]);
    });
    demo.on("error", reject);
    demo.on("exit", () => reject(new Error("Fictional MCP exited before ready")));
  });
  const launches: AgentSessionConfig[] = [];
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.13.0-beta.1",
    mcpEnabled: false,
    agentClients: {
      codex: createTestAgentClient("codex", {
        supportsMcpServers: true,
        beforeCreateSession: async (config) => {
          launches.push(config);
        },
      }),
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.13.0-beta.1",
  });
  const mcp = new Client({ name: "provider-direct-acceptance", version: "1" });
  try {
    const url = await ready;
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/repository-mcp", import.meta.url)),
    );
    expect(
      await client.invokePluginRpc("repository-mcp", "settings.connection.write", {
        revision: "missing",
        values: { url },
      }),
    ).toMatchObject({ status: "saved" });
    await expect
      .poll(
        async () =>
          (await client.listPlugins()).find((plugin) => plugin.id === "repository-mcp")?.mcpServer
            ?.configured,
      )
      .toBe(true);
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      provider: "codex",
      cwd: fileURLToPath(new URL("../../../../../plugin-examples/repository-mcp", import.meta.url)),
    });
    const definition = launches[0].mcpServers?.["plugin_repository-mcp_repositories"];
    if (!definition || definition.type !== "http")
      throw new Error("Missing registered HTTP service in provider config");
    expect(definition.url).toBe(url);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(definition.url)));
    expect(await mcp.listTools()).toMatchObject({ tools: [{ name: "list_repositories" }] });
    for (const mode of ["normal", "empty", "failure"] as const) {
      const rpc = await client.invokePluginRpc("repository-mcp", "repositories.list", { mode });
      const result = await mcp.callTool({ name: "list_repositories", arguments: { mode } });
      if (mode === "normal") {
        expect(rpc).toEqual({
          repositories: [
            { id: "orchard", path: "demo/orchard" },
            { id: "harbor", path: "demo/harbor" },
          ],
          error: null,
        });
        expect(result).toMatchObject({
          structuredContent: {
            repositories: [
              { id: "orchard", path: "demo/orchard" },
              { id: "harbor", path: "demo/harbor" },
            ],
          },
        });
      } else if (mode === "empty") {
        expect(rpc).toEqual({ repositories: [], error: null });
        expect(result).toMatchObject({
          structuredContent: { repositories: [] },
          content: [{ type: "text", text: "No repositories" }],
        });
      } else {
        expect(rpc).toMatchObject({
          repositories: [],
          error: "Fictional repository access failed; retry the normal request.",
        });
        expect(result).toMatchObject({
          isError: true,
          content: [
            { type: "text", text: "Fictional repository access failed; retry the normal request." },
          ],
        });
      }
    }
    expect(
      await client.invokePluginRpc("repository-mcp", "repositories.list", { mode: "normal" }),
    ).toMatchObject({ error: null });
    await client.archiveAgent(agent.id);
  } finally {
    await mcp.close();
    await client.close();
    await daemon.close();
    demo.kill();
    await exited;
  }
}, 60_000);

test("manual MCP saves replace individual definitions and distribute only to new Agent runtimes", async () => {
  const launches: AgentSessionConfig[] = [];
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: {
      codex: createTestAgentClient("codex", {
        supportsMcpServers: true,
        beforeCreateSession: async (config) => {
          launches.push(config);
        },
      }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const first = {
      name: "repository",
      enabled: true,
      config: {
        type: "stdio" as const,
        command: "nonexistent-mcp-test-command",
        args: ["--flag"],
        env: { TOKEN: "fictional-secret" },
      },
    };
    await client.patchDaemonConfig({ mcpServers: { first } });
    expect((await client.getDaemonConfig()).config.mcpServers).toEqual({ first });
    await expect(
      client.patchDaemonConfig({
        mcpServers: { invalid: { ...first, config: { type: "http", url: "file:///private" } } },
      }),
    ).rejects.toThrow();
    await expect(
      client.patchDaemonConfig({
        mcpServers: { invalid: { ...first, config: { type: "stdio", command: "   " } } },
      }),
    ).rejects.toThrow();
    expect((await client.getDaemonConfig()).config.mcpServers).toEqual({ first });
    expect(launches).toEqual([]);
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({ provider: "codex", cwd: daemon.paseoHome });
    expect(launches[0].mcpServers).toEqual({ paseo_manual_first: first.config });
    expect(JSON.stringify(agent)).not.toContain("fictional-secret");
    const second = {
      name: "events",
      enabled: true,
      config: {
        type: "sse" as const,
        url: "https://invalid.example/sse",
        headers: { authorization: "fictional-header" },
      },
    };
    await client.patchDaemonConfig({ mcpServers: { second } });
    const edited = {
      ...first,
      config: { type: "http" as const, url: "https://invalid.example/mcp" },
    };
    await client.patchDaemonConfig({ mcpServers: { first: edited } });
    expect((await client.getDaemonConfig()).config.mcpServers).toEqual({ first: edited, second });
    expect(launches).toHaveLength(1);
    await expect(client.patchDaemonConfig({ mcpServers: { duplicate: edited } })).rejects.toThrow(
      "name",
    );
    expect((await client.getDaemonConfig()).config.mcpServers).toEqual({ first: edited, second });
    const next = await client.createAgent({ provider: "codex", cwd: daemon.paseoHome });
    expect(launches[1].mcpServers).toEqual({
      paseo_manual_first: edited.config,
      paseo_manual_second: second.config,
    });
    await expect(
      client.createAgent({
        provider: "codex",
        cwd: daemon.paseoHome,
        mcpServers: { paseo_manual_first: edited.config },
      }),
    ).rejects.toThrow("conflicts");
    await client.archiveAgent(agent.id);
    await client.archiveAgent(next.id);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("manual MCP configuration survives daemon restart and remains isolated by host", async () => {
  const launches: AgentSessionConfig[] = [];
  const resumes: AgentSessionConfig[] = [];
  const clients = {
    codex: createTestAgentClient("codex", {
      supportsMcpServers: true,
      beforeCreateSession: async (config) => {
        launches.push(config);
      },
      beforeResumeSession: async (config) => {
        resumes.push(config);
      },
    }),
  };
  const first = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: clients,
    cleanup: false,
  });
  const other = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws` });
  const otherClient = new DaemonClient({ url: `ws://127.0.0.1:${other.port}/ws` });
  let restarted: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
  let restartedClient: DaemonClient | undefined;
  const service = {
    name: "Saved service",
    enabled: true,
    config: {
      type: "http" as const,
      url: "https://invalid.example/mcp",
      headers: { authorization: "fictional-persisted-secret" },
    },
  };
  try {
    await Promise.all([client.connect(), otherClient.connect()]);
    await client.patchDaemonConfig({ mcpServers: { persistent: service } });
    expect((await otherClient.getDaemonConfig()).config.mcpServers).toEqual({});
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      provider: "codex",
      cwd: first.paseoHome,
      mcpServers: { personal: { type: "http", url: "https://personal.example/mcp" } },
    });
    const edited = {
      ...service,
      config: { type: "sse" as const, url: "https://invalid.example/events" },
    };
    await client.patchDaemonConfig({ mcpServers: { persistent: edited } });
    expect(resumes).toEqual([]);
    await client.refreshAgent(agent.id);
    expect(resumes[0].mcpServers).toEqual({
      personal: { type: "http", url: "https://personal.example/mcp" },
      paseo_manual_persistent: edited.config,
    });
    const disabled = { ...edited, enabled: false };
    await client.patchDaemonConfig({
      mcpServers: { persistent: disabled, retained: { ...service, name: "Retained service" } },
    });
    expect(resumes).toHaveLength(1);
    expect(launches).toHaveLength(1);
    expect((await client.getDaemonConfig()).config.mcpServers?.persistent).toEqual(disabled);
    await client.refreshAgent(agent.id);
    expect(resumes[1].mcpServers).toEqual({
      personal: { type: "http", url: "https://personal.example/mcp" },
      paseo_manual_retained: service.config,
    });
    await client.patchDaemonConfig({ mcpServers: { persistent: edited } });
    await client.refreshAgent(agent.id);
    expect(resumes[2].mcpServers).toEqual({
      personal: { type: "http", url: "https://personal.example/mcp" },
      paseo_manual_persistent: edited.config,
      paseo_manual_retained: service.config,
    });
    await client.patchDaemonConfig({ mcpServers: { persistent: disabled } });
    await client.archiveAgent(agent.id);
    await client.close();
    await first.close();
    restarted = await createPaseoDaemon(
      {
        ...first.config,
        ...loadConfig(first.paseoHome, { env: {} }),
        listen: "127.0.0.1:0",
        relayEnabled: false,
        mcpEnabled: false,
        agentClients: clients,
        staticDir: first.staticDir,
      },
      pino({ level: "silent" }),
      { builtinPlugins: new BuiltinPluginLoader(undefined, []) },
    );
    await restarted.start();
    const target = restarted.getListenTarget();
    if (target?.type !== "tcp") throw new Error("Missing isolated listener");
    restartedClient = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws` });
    await restartedClient.connect();
    expect((await restartedClient.getDaemonConfig()).config.mcpServers).toEqual({
      persistent: disabled,
      retained: { ...service, name: "Retained service" },
    });
    await restartedClient.fetchAgents({ subscribe: {} });
    const afterRestart = await restartedClient.createAgent({
      provider: "codex",
      cwd: first.paseoHome,
    });
    expect(launches.at(-1)?.mcpServers).toEqual({ paseo_manual_retained: service.config });
    await restartedClient.patchDaemonConfig({ mcpServers: { persistent: null } });
    expect((await restartedClient.getDaemonConfig()).config.mcpServers).toEqual({
      retained: { ...service, name: "Retained service" },
    });
    const resumeCount = resumes.length;
    await restartedClient.refreshAgent(afterRestart.id);
    expect(resumes[resumeCount].mcpServers).toEqual({ paseo_manual_retained: service.config });
    await restartedClient.archiveAgent(afterRestart.id);
    expect((await otherClient.getDaemonConfig()).config.mcpServers).toEqual({});
  } finally {
    await restartedClient?.close();
    await restarted?.stop();
    await client.close();
    await first.close();
    await otherClient.close();
    await other.close();
    await rm(path.dirname(first.paseoHome), { recursive: true, force: true });
    await rm(first.staticDir, { recursive: true, force: true });
  }
}, 60_000);
