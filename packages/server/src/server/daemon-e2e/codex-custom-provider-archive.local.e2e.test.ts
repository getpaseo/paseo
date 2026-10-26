import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createCodexArchiveContextFixture } from "./test-utils/codex-archive-context.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Runs the real `codex` binary against a local Responses endpoint standing in
// for a custom provider's OPENAI_BASE_URL, so no login is needed.

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function finalAnswer(): string {
  return sse([
    { type: "response.created", response: { id: "resp-1" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "msg-1",
        content: [{ type: "output_text", text: "done" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]);
}

async function startResponsesEndpoint(): Promise<{
  baseUrl: string;
  server: Server;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end();
        return;
      }
      requests += 1;
      res.setHeader("content-type", "text/event-stream");
      res.end(finalAnswer());
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    server,
    requestCount: () => requests,
  };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

describe("Codex custom provider archive", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  test.each(["live", "closed", "restarted"])(
    "archive and restore a %s agent with fresh per-agent plugin context",
    async (state) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "codex-context-archive-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const { codexHome, cwd, plugin, staticDir, launches, wrapper } =
        createCodexArchiveContextFixture(root);
      const { baseUrl, server } = await startResponsesEndpoint();
      cleanups.push(() => closeServer(server));
      const daemonOptions: Parameters<typeof createTestPaseoDaemon>[0] = {
        paseoHomeRoot: path.join(root, "daemon"),
        staticDir,
        cleanup: false,
        plugins: { "archive-context": { source: "directory", path: plugin, enabled: true } },
        logger: createTestLogger(),
        pluginsEnabled: true,
        providerOverrides: {
          "context-codex": {
            extends: "codex",
            label: "Context Codex",
            command: [process.execPath, wrapper],
            env: { CODEX_HOME: codexHome, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "test-key" },
          },
        },
      };
      async function startDaemon() {
        const daemon = await createTestPaseoDaemon(daemonOptions);
        cleanups.push(() => daemon.close());
        const client = new DaemonClient({
          url: `ws://127.0.0.1:${daemon.port}/ws`,
          appVersion: "0.11.2",
        });
        cleanups.push(() => client.close());
        await client.connect();
        await client.fetchAgents({ subscribe: {} });
        return { daemon, client };
      }
      let { daemon, client } = await startDaemon();
      async function restartDaemon() {
        await client.close();
        await daemon.close();
        ({ daemon, client } = await startDaemon());
      }
      const agent = await client.createAgent({
        config: { provider: "context-codex", cwd, model: "mock-model", modeId: "full-access" },
      });
      await daemon.daemon.agentManager.runAgent(agent.id, "hello with session context");
      const persistence = (await daemon.daemon.agentStorage.get(agent.id))?.persistence;
      if (state === "closed") await daemon.daemon.agentManager.closeAgent(agent.id);
      if (state === "restarted") await restartDaemon();
      await client.archiveAgent(agent.id);
      expect(readdirSync(path.join(codexHome, "archived_sessions"))).toHaveLength(1);
      expect((await daemon.daemon.agentStorage.get(agent.id))?.archivedAt).toEqual(
        expect.any(String),
      );
      if (state === "restarted") await restartDaemon();
      await client.refreshAgent(agent.id);
      await daemon.daemon.agentManager.runAgent(agent.id, "hello after restoring");
      const operations = readFileSync(launches, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(operations).toContainEqual(
        expect.objectContaining({
          method: "thread/archive",
          valid: true,
          reason: "archive",
          purpose: "maintenance",
          workspaceId: agent.workspaceId,
        }),
      );
      expect(operations).toContainEqual(
        expect.objectContaining({
          method: "thread/unarchive",
          valid: true,
          reason: "restore",
          purpose: "maintenance",
          workspaceId: agent.workspaceId,
        }),
      );
      expect(readdirSync(path.join(codexHome, "archived_sessions"))).toEqual([]);
      const stored = await daemon.daemon.agentStorage.get(agent.id);
      expect(stored?.archivedAt).toBeNull();
      expect(stored?.persistence?.sessionId).toBe(persistence?.sessionId);
      const generations = [
        operations.find((operation) => operation.method === "thread/start")?.generation,
        operations.find((operation) => operation.method === "thread/archive")?.generation,
        operations.find((operation) => operation.method === "thread/unarchive")?.generation,
      ];
      expect(generations).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
      expect(new Set(generations).size).toBe(state === "restarted" ? 3 : 1);
      expect(
        operations
          .filter((operation) => operation.method === "thread/resume")
          .map((operation) => operation.generation),
      ).toEqual([generations[2]]);
      expect(JSON.stringify(stored)).not.toContain("SESSION_AGENT_ID");
    },
    120_000,
  );

  test("archiving hides the session from Import session and unarchiving lists it again", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codex-custom-archive-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    mkdirSync(codexHome);
    const cwd = path.join(root, "project");
    mkdirSync(cwd);
    const { baseUrl, server } = await startResponsesEndpoint();
    cleanups.push(() => closeServer(server));

    const daemon = await createTestPaseoDaemon({
      logger: createTestLogger(),
      pluginsEnabled: false,
      providerOverrides: {
        "my-codex": {
          extends: "codex",
          label: "My Codex",
          env: { CODEX_HOME: codexHome, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "test-key" },
        },
      },
    });
    cleanups.push(() => daemon.close());
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    cleanups.push(() => client.close());
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const manager = daemon.daemon.agentManager;

    const agent = await client.createAgent({
      config: { provider: "my-codex", cwd, model: "mock-model", modeId: "full-access" },
    });
    await manager.runAgent(agent.id, "hello from the custom provider");
    const importable = async () =>
      (await manager.listImportableSessions({ cwd, providerFilter: new Set(["my-codex"]) }))
        .sessions;
    expect(await importable()).toHaveLength(1);

    await client.archiveAgent(agent.id);
    expect(await importable()).toEqual([]);

    await client.refreshAgent(agent.id);
    expect(await importable()).toHaveLength(1);
  }, 120_000);
});
