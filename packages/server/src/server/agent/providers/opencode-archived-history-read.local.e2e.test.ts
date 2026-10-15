import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { ensureAgentLoaded } from "../agent-loading.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

const SENTINEL = "PASEO_OPENCODE_HISTORY_4B71";
const TIMEOUT_MS = 300_000;

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Port reservation failed");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/**
 * Every OpenCode request Paseo makes passes through here. `session.abort` is
 * OpenCode's only way to interrupt a session, and it is session-scoped rather
 * than turn-scoped, so an abort issued on behalf of a history read cancels
 * whatever that session happens to be running. A global event subscription is
 * the other thing an interactive resume drags in that a read has no use for.
 */
async function createRecordingProxy(upstreamPort: number) {
  const requests: Array<{ method: string; url: string }> = [];
  const server = createServer((incoming, outgoing) => {
    requests.push({ method: incoming.method ?? "", url: incoming.url ?? "" });
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind");
  return {
    port: address.port,
    aborts(sessionId: string): number {
      return requests.filter(
        (entry) => entry.method === "POST" && entry.url.includes(`/session/${sessionId}/abort`),
      ).length;
    },
    globalEventConnections(): number {
      return requests.filter((entry) => entry.url.startsWith("/global/event")).length;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe.sequential("OpenCode archived history read (local)", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeAll(async () => {
    harness = await createHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 60_000);

  test(
    "never aborts the native session and attaches to no event stream",
    async () => {
      const { agentId, sessionId } = await harness.createArchivedHistory();
      const abortsBefore = harness.proxy.aborts(sessionId);
      const eventStreamsBefore = harness.proxy.globalEventConnections();
      const { timeline } = await harness.readAndCloseHistory(agentId);

      expect(timeline).toContainEqual(
        expect.objectContaining({
          type: "user_message",
          text: SENTINEL,
        }),
      );

      expect(
        harness.proxy.aborts(sessionId) - abortsBefore,
        "a history read must not abort the native session",
      ).toBe(0);

      expect(
        harness.proxy.globalEventConnections() - eventStreamsBefore,
        "a history read must not attach to the global event stream",
      ).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "restores saved child and grandchild history into a closed snapshot",
    async () => {
      const { agentId, childId, grandchildId } = await harness.createArchivedHistory();

      const history = await harness.readAndCloseHistory(agentId);

      expect(
        history.subagents.map((child) => ({
          id: child.id,
          parentSubagentId: child.parentSubagentId,
          description: child.description,
          status: child.status,
        })),
      ).toEqual([
        { id: childId, parentSubagentId: null, description: "Child task", status: "completed" },
        {
          id: grandchildId,
          parentSubagentId: childId,
          description: "Nested task",
          status: "completed",
        },
      ]);
      expect(history.childTimelines).toEqual([
        [expect.objectContaining({ type: "user_message", text: `${SENTINEL}_CHILD` })],
        [expect.objectContaining({ type: "user_message", text: `${SENTINEL}_GRANDCHILD` })],
      ]);
      expect(history.liveAgent).toBeNull();
      expect(history.archivedAt).toEqual(expect.any(String));
    },
    TIMEOUT_MS,
  );
});

async function createHarness() {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-history-"));
  const home = path.join(runtimeDir, "home");
  const xdgConfig = path.join(runtimeDir, "xdg-config");
  const xdgData = path.join(runtimeDir, "xdg-data");
  const xdgCache = path.join(runtimeDir, "xdg-cache");
  const xdgState = path.join(runtimeDir, "xdg-state");
  const workspace = path.join(runtimeDir, "workspace");
  for (const directory of [home, xdgConfig, xdgData, xdgCache, xdgState, workspace]) {
    mkdirSync(directory, { recursive: true });
  }
  // OpenCode keys a session to its project, which it resolves from the git root.
  execFileSync("git", ["init", "-q"], { cwd: workspace });

  const isolatedEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTO_UPDATE: "1",
  };

  const upstreamPort = await reservePort();
  const proxy = await createRecordingProxy(upstreamPort);
  const logger = pino({ level: "silent" });
  let serverProcess: ChildProcess | null = null;
  const placeholders: ChildProcess[] = [];
  const serverManager = new OpenCodeServerManager({
    logger,
    portAllocator: async () => proxy.port,
    resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
    resolveHomeDir: () => home,
    // Without a bridge every acquisition asks for a dedicated server. One real
    // OpenCode process backs them all, so every request still lands on the same
    // session; later acquisitions get a live placeholder that announces the
    // readiness line the manager waits for.
    spawnServerProcess: () => {
      if (serverProcess) {
        const placeholder = spawn(
          process.execPath,
          [
            "-e",
            `console.log("listening on 127.0.0.1:${upstreamPort}"); setInterval(() => {}, 1000)`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        placeholders.push(placeholder);
        return placeholder;
      }
      serverProcess = spawn("opencode", ["serve", "--port", String(upstreamPort)], {
        cwd: workspace,
        env: isolatedEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return serverProcess;
    },
  });
  const closeServer = async () => {
    await serverManager.shutdown();
    serverProcess?.kill("SIGKILL");
    for (const placeholder of placeholders) placeholder.kill("SIGKILL");
    await proxy.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  };
  const lease = await serverManager.acquireCurrent().catch(async (error: unknown) => {
    await closeServer();
    throw error;
  });
  const client = new OpenCodeAgentClient(logger, undefined, { serverManager });
  const storage = new AgentStorage(path.join(runtimeDir, "agents"), logger);
  const manager = new AgentManager({
    clients: { opencode: client },
    registry: storage,
    logger,
  });
  const nativeClient = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${proxy.port}`,
    directory: workspace,
  });
  const writeHistory = async (sessionId: string, text: string) => {
    // noReply persists a real OpenCode message without invoking a model. The subject
    // is the stored history and its read side effects, so model inference adds no coverage.
    const response = await nativeClient.session.prompt({
      sessionID: sessionId,
      directory: workspace,
      noReply: true,
      parts: [{ type: "text", text }],
    });
    if (response.error)
      throw new Error(`Failed to write OpenCode history: ${JSON.stringify(response.error)}`);
  };
  const createChild = async (parentID: string, title: string, text: string) => {
    const response = await nativeClient.session.create({ directory: workspace, parentID, title });
    if (response.error || !response.data)
      throw new Error(`Failed to create OpenCode child: ${JSON.stringify(response.error)}`);
    await writeHistory(response.data.id, text);
    return response.data.id;
  };

  return {
    proxy,
    async createArchivedHistory() {
      const created = await manager.createAgent(
        { provider: "opencode", cwd: workspace, modeId: "build" },
        undefined,
        { workspaceId: undefined },
      );
      const sessionId = created.persistence?.sessionId;
      if (!sessionId) throw new Error("OpenCode agent did not persist its session ID");
      await writeHistory(sessionId, SENTINEL);
      const childId = await createChild(sessionId, "Child task", `${SENTINEL}_CHILD`);
      const grandchildId = await createChild(childId, "Nested task", `${SENTINEL}_GRANDCHILD`);
      await manager.archiveAgent(created.id);
      manager.discardHistoryState(created.id);
      return { agentId: created.id, sessionId, childId, grandchildId };
    },
    async readAndCloseHistory(agentId: string) {
      await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
      const subagents = manager.listProviderSubagents(agentId);
      const history = {
        timeline: manager.getTimeline(agentId),
        subagents,
        childTimelines: subagents.map((child) =>
          manager.fetchProviderSubagentTimeline(agentId, child.id).rows.map((row) => row.item),
        ),
        liveAgent: manager.getAgent(agentId),
        archivedAt: (await storage.get(agentId))?.archivedAt,
      };
      await manager.closeAgent(agentId);
      return history;
    },
    async close() {
      try {
        await storage.flush();
        await lease.release();
      } finally {
        await closeServer();
      }
    },
  };
}
