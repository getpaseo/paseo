import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test } from "vitest";
import { z } from "zod";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const evidence = path.join(root, "artifacts/plugin-mcp-services");
const repositories = [
  { id: "orchard", path: "demo/orchard" },
  { id: "harbor", path: "demo/harbor" },
];
const serviceName = "plugin_repository-mcp_repositories";
const serviceScript = fileURLToPath(new URL("./test-fixtures/repository-mcp.mjs", import.meta.url));
const proofEvent = z.object({
  event: z.string(),
  pid: z.number(),
  transport: z.string(),
  cwd: z.string(),
  protocolVersion: z.string().optional(),
  clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
});

async function events(file: string) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => proofEvent.parse(JSON.parse(line)));
}

test.each([
  { provider: "codex" as const, transport: "stdio" as const },
  { provider: "claude" as const, transport: "http" as const },
])(
  "real $provider directly calls a plugin's $transport MCP service",
  async ({ provider, transport }) => {
    await mkdir(evidence, { recursive: true });
    const directory = await mkdtemp(path.join(tmpdir(), `paseo-${provider}-mcp-proof-`));
    const plugin = path.join(directory, "plugin");
    const cwd = path.join(directory, "workspace");
    await mkdir(cwd);
    const traceFile = path.join(evidence, `${provider}-service.jsonl`);
    await writeFile(traceFile, "");
    const proof: Record<string, unknown> = {
      provider,
      transport,
      binary: execFileSync(provider, ["--version"], { encoding: "utf8" }).trim(),
      paseo: resolveDaemonVersion(),
      node: process.version,
      serviceScript,
    };
    const logger = pino({ level: "silent" });
    const native =
      provider === "codex"
        ? new CodexAppServerAgentClient(logger)
        : new ClaudeAgentClient({ logger });
    const daemon = await createTestPaseoDaemon({
      logger,
      agentClients: { [provider]: native },
      mcpEnabled: false,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: resolveDaemonVersion(),
    });
    let projectId: string | undefined;
    let agentId: string | undefined;
    let remote: ReturnType<typeof spawn> | undefined;
    let remoteExit: Promise<unknown> | undefined;
    try {
      await cp(path.join(root, "plugin-examples/repository-mcp"), plugin, { recursive: true });
      if (transport === "stdio") {
        await writeFile(
          path.join(plugin, "index.server.ts"),
          `
        import { repositories } from "./shared/repositories";
        import { listRepositories } from "./server/repositories";
        export default function contribute(server) {
          server.handle(repositories, listRepositories);
          const registration = server.registerMcpServer({ id: "repositories", label: "Fictional repositories", config: {
            type: "stdio", command: ${JSON.stringify(process.execPath)}, args: ${JSON.stringify([serviceScript, "stdio", traceFile])}, cwd: server.directory
          }});
          return () => registration.remove();
        }
      `,
        );
        proof.registeredDefinition = {
          type: "stdio",
          command: process.execPath,
          args: [serviceScript, "stdio", traceFile],
          cwd: plugin,
        };
      } else {
        remote = spawn(process.execPath, [serviceScript, "http", traceFile], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        remoteExit = once(remote, "exit");
        const endpoint = await new Promise<string>((resolve, reject) => {
          let output = "";
          remote!.stdout!.on("data", (chunk) => {
            output += String(chunk);
            const match = /Fictional MCP: (http:\/\/[^\s]+)/.exec(output);
            if (match) resolve(match[1]);
          });
          remote!.once("error", reject);
          remote!.once("exit", () =>
            reject(new Error("Fictional HTTP service exited before ready")),
          );
        });
        proof.registeredDefinition = { type: "http", url: endpoint };
      }
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(plugin);
      if (transport === "http") {
        const definition = z.object({ url: z.string() }).parse(proof.registeredDefinition);
        await client.invokePluginRpc("repository-mcp", "settings.connection.write", {
          revision: "missing",
          values: { url: definition.url },
        });
      }
      await expect
        .poll(
          async () =>
            (await client.listPlugins()).find((entry) => entry.id === "repository-mcp")?.mcpServer
              ?.configured,
        )
        .toBe(true);
      const rpc = await client.invokePluginRpc("repository-mcp", "repositories.list", {
        mode: "normal",
      });
      expect(rpc).toEqual({ repositories, error: null });
      proof.ordinaryRpc = rpc;
      const catalog = await native.fetchCatalog({ scope: "workspace", cwd, force: false });
      // A CLI manifest default can be newer than the configured API gateway.
      const configuredModel =
        provider === "claude"
          ? (catalog.models.find(
              (entry) => entry.description === "From Claude settings.json env.ANTHROPIC_MODEL",
            ) ??
            catalog.models.find((entry) => entry.description === "From Claude settings.json model"))
          : undefined;
      const model =
        configuredModel ??
        catalog.models.find((entry) => entry.isDefault && entry.isSelectable !== false) ??
        catalog.models.find((entry) => entry.isSelectable !== false);
      if (!model) throw new Error(`${provider} did not advertise an available model`);
      proof.model = model.id;
      proof.modelSource = model.description;
      proof.catalogModels = catalog.models.map(({ id, isDefault, isSelectable }) => ({
        id,
        isDefault,
        isSelectable,
      }));
      const created = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
      if (!created.workspace) throw new Error(created.error ?? "Workspace not created");
      projectId = created.workspace.projectId;
      const agent = await client.createAgent({
        provider,
        cwd,
        workspaceId: created.workspace.id,
        model: model.id,
        modeId: provider === "codex" ? "auto" : "default",
        title: "Fictional MCP direct acceptance",
      });
      agentId = agent.id;
      const approvals: unknown[] = [];
      proof.approvals = approvals;
      let turnFailure: string | undefined;
      await client.sendMessage(
        agent.id,
        `Use the list_repositories MCP tool from ${serviceName} with exactly {"mode":"normal"}. Report both returned fictional repository paths and finish with REPOSITORIES_OK. Use provider-native tool discovery if needed. Do not use shell, filesystem, web, other agents or unrelated tools.`,
      );
      await expect
        .poll(
          async () => {
            const timeline = await client.fetchAgentTimeline(agent.id, {
              direction: "tail",
              limit: 200,
              projection: "canonical",
            });
            proof.timeline = timeline.entries;
            proof.status = timeline.agent.status;
            if (timeline.agent.lastError) {
              turnFailure = `${provider} turn failed: ${timeline.agent.lastError}`;
              return true;
            }
            for (const request of timeline.agent.pendingPermissions) {
              const running = timeline.entries.findLast(
                (entry) => entry.item.type === "tool_call" && entry.item.status === "running",
              )?.item;
              const nativeCall =
                request.name.includes("list_repositories") &&
                request.name.includes("repository-mcp");
              const codexCall =
                request.name === "CodexMcpElicitation" &&
                request.metadata?.serverName === serviceName &&
                running?.type === "tool_call" &&
                running.name.includes("list_repositories");
              const discovery =
                request.name === "ToolSearch" &&
                JSON.stringify(request.input).includes("list_repositories");
              const allowed = nativeCall || codexCall || discovery;
              approvals.push({ request, allowed });
              await client.respondToPermission(
                agent.id,
                request.id,
                allowed
                  ? { behavior: "allow" }
                  : { behavior: "deny", message: "Outside fictional repository acceptance scope" },
              );
              if (!allowed) {
                turnFailure = `Unexpected requested tool: ${request.name}`;
                return true;
              }
            }
            const messages = timeline.entries.flatMap((entry) =>
              entry.item.type === "assistant_message" ? [entry.item.text] : [],
            );
            if (messages.some((text) => text.includes("REPOSITORIES_OK"))) return true;
            if (
              timeline.agent.status === "error" ||
              (timeline.agent.status === "idle" && messages.length > 0)
            ) {
              turnFailure = `${provider} stopped without completing the fictional call: ${messages.join("\n")}`;
              return true;
            }
            return false;
          },
          { timeout: 240_000, interval: 500 },
        )
        .toBe(true);
      if (turnFailure) throw new Error(turnFailure);
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 30_000);
      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 200,
        projection: "canonical",
      });
      proof.timeline = timeline.entries;
      const calls = timeline.entries.flatMap((entry) =>
        entry.item.type === "tool_call" ? [entry.item] : [],
      );
      expect(
        calls.map((call) => call.name).filter((name) => /discover_tools|invoke_tool/.test(name)),
      ).toEqual([]);
      const call = calls.find(
        (entry) => entry.name.includes("list_repositories") && entry.status === "completed",
      );
      if (!call || call.detail.type !== "unknown")
        throw new Error("Missing completed native MCP call");
      expect(call.detail.input).toEqual({ mode: "normal" });
      expect(JSON.stringify(call.detail.output)).toContain("demo/orchard");
      expect(JSON.stringify(call.detail.output)).toContain("demo/harbor");
      proof.nativeTool = call.name;
      const trace = await events(traceFile);
      proof.serviceEvents = trace;
      expect(trace).toContainEqual(
        expect.objectContaining({
          event: "initialize",
          protocolVersion: expect.any(String),
          clientInfo: expect.objectContaining({
            name: expect.any(String),
            version: expect.any(String),
          }),
        }),
      );
      expect(trace).toContainEqual(
        expect.objectContaining({
          event: "call",
          name: "list_repositories",
          arguments: { mode: "normal" },
          result: { repositories, error: null },
        }),
      );
      if (transport === "stdio")
        expect(trace.find((entry) => entry.event === "call")?.cwd).toBe(plugin);
      expect(trace.every((entry) => entry.pid > 0 && entry.transport === transport)).toBe(true);
      proof.result = "passed";
    } finally {
      await writeFile(
        path.join(evidence, `${provider}-native.json`),
        JSON.stringify(proof, null, 2),
      );
      if (agentId) await client.archiveAgent(agentId).catch(() => undefined);
      if (projectId) await client.removeProject(projectId).catch(() => undefined);
      await client.close();
      await daemon.close();
      remote?.kill();
      await remoteExit;
      await rm(directory, { recursive: true, force: true });
    }
  },
  300_000,
);
