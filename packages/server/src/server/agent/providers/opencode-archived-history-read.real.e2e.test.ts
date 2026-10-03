import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ensureAgentLoaded } from "../agent-loading.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

const SENTINEL = "PASEO_OPENCODE_HISTORY_4B71";
const TIMEOUT_MS = 300_000;

/**
 * Any OpenAI-compatible endpoint drives this test. OpenRouter's compatibility
 * layer is the zero-config default; PASEO_TEST_OPENAI_* points it at a local
 * gateway instead.
 */
function resolveModelBackend(): { baseURL: string; apiKey: string; model: string } | null {
  const baseURL = process.env.PASEO_TEST_OPENAI_BASE_URL?.trim();
  const apiKey = process.env.PASEO_TEST_OPENAI_API_KEY?.trim();
  const model = process.env.PASEO_TEST_OPENAI_MODEL?.trim();
  if (baseURL && apiKey && model) {
    return { baseURL, apiKey, model };
  }
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    return {
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openRouterKey,
      model: "google/gemini-2.5-flash-lite",
    };
  }
  return null;
}

function isOpenCodeInstalled(): boolean {
  try {
    return execFileSync("which", ["opencode"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function writeOpenCodeConfig(
  xdgConfig: string,
  backend: { baseURL: string; apiKey: string; model: string },
): void {
  const providerDir = path.join(xdgConfig, "opencode");
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(
    path.join(providerDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          harness: {
            npm: "@ai-sdk/openai-compatible",
            name: "harness",
            options: { baseURL: backend.baseURL, apiKey: backend.apiKey },
            models: { [backend.model]: { name: backend.model } },
          },
        },
      },
      null,
      2,
    ),
  );
}

const backend = resolveModelBackend();

describe.sequential("OpenCode archived history read (real)", () => {
  let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

  beforeAll(async () => {
    if (!backend || !isOpenCodeInstalled()) return;
    harness = await createHarness(backend);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 60_000);

  test(
    "never aborts the native session and attaches to no event stream",
    async (context) => {
      if (!harness) {
        context.skip();
        return;
      }
      const { manager, storage, workspace, model, proxy, logger } = harness;

      // A real OpenCode session carrying real history.
      const created = await manager.createAgent(
        { provider: "opencode", cwd: workspace, model, modeId: "build" },
        undefined,
        { workspaceId: undefined },
      );
      const agentId = created.id;
      await manager.runAgent(agentId, `Reply with exactly ${SENTINEL} and no other text.`);
      const sessionId = manager.getAgent(agentId)?.persistence?.sessionId;
      expect(sessionId).toBeTruthy();

      await manager.archiveAgent(agentId);

      const abortsBefore = proxy.aborts(sessionId!);
      const eventStreamsBefore = proxy.globalEventConnections();

      // The history read, then the close that closing a tab would trigger.
      await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
      expect(manager.getTimeline(agentId).length).toBeGreaterThan(0);
      if (manager.getAgent(agentId)) {
        await manager.closeAgent(agentId);
      }

      expect(
        proxy.aborts(sessionId!) - abortsBefore,
        "a history read must not abort the native session",
      ).toBe(0);

      expect(
        proxy.globalEventConnections() - eventStreamsBefore,
        "a history read must not attach to the global event stream",
      ).toBe(0);
    },
    TIMEOUT_MS,
  );
});

async function createHarness(modelBackend: { baseURL: string; apiKey: string; model: string }) {
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
  writeOpenCodeConfig(xdgConfig, modelBackend);
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
  let child: ChildProcess | null = null;
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
      if (child) {
        const placeholder = spawn(
          "sh",
          ["-c", `echo "listening on 127.0.0.1:${upstreamPort}"; sleep 100000`],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        placeholders.push(placeholder);
        return placeholder;
      }
      child = spawn("opencode", ["serve", "--port", String(upstreamPort)], {
        cwd: workspace,
        env: isolatedEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return child;
    },
  });
  const lease = await serverManager.acquireCurrent();
  const client = new OpenCodeAgentClient(logger, undefined, { serverManager });
  const storage = new AgentStorage(path.join(runtimeDir, "agents"), logger);
  const manager = new AgentManager({
    clients: { opencode: client },
    registry: storage,
    logger,
  });

  return {
    manager,
    storage,
    workspace,
    logger,
    proxy,
    model: `harness/${modelBackend.model}`,
    async close() {
      await storage.flush();
      await lease.release();
      await proxy.close();
      child?.kill("SIGKILL");
      for (const placeholder of placeholders) placeholder.kill("SIGKILL");
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}
