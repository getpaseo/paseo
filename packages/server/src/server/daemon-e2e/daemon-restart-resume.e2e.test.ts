import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import pino from "pino";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { PersistenceHandle } from "../../shared/messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

async function getAvailablePort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

interface DaemonInstance {
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
  client: DaemonClient;
  port: number;
  paseoHome: string;
  staticDir: string;
}

async function startDaemon(options: {
  paseoHome: string;
  staticDir?: string;
}): Promise<DaemonInstance> {
  const port = await getAvailablePort();
  const staticDir = options.staticDir ?? await mkdtemp(path.join(tmpdir(), "paseo-static-"));

  const config: PaseoDaemonConfig = {
    listen: `127.0.0.1:${port}`,
    paseoHome: options.paseoHome,
    corsAllowedOrigins: [],
    agentMcpRoute: "/mcp/agents",
    agentMcpAllowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    staticDir,
    mcpDebug: false,
    agentClients: {},
    agentRegistryPath: path.join(options.paseoHome, "agents.json"),
    agentControlMcp: {
      url: `http://127.0.0.1:${port}/mcp/agents`,
    },
    openai: process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : undefined,
  };

  const logger = pino({ level: "silent" });
  const daemon = await createPaseoDaemon(config, logger);
  await daemon.start();

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
  });
  await client.connect();

  return {
    daemon,
    client,
    port,
    paseoHome: options.paseoHome,
    staticDir,
  };
}

async function stopDaemon(instance: DaemonInstance): Promise<void> {
  await instance.client.close();
  await instance.daemon.stop();
  await new Promise((r) => setTimeout(r, 200));
}

describe("daemon restart and agent resume", () => {
  let paseoHome: string | null = null;
  let staticDir: string | null = null;
  let cwd: string | null = null;
  let currentDaemon: DaemonInstance | null = null;

  afterEach(async () => {
    if (currentDaemon) {
      await stopDaemon(currentDaemon).catch(() => undefined);
      currentDaemon = null;
    }
    if (paseoHome) {
      await rm(paseoHome, { recursive: true, force: true }).catch(() => undefined);
      paseoHome = null;
    }
    if (staticDir) {
      await rm(staticDir, { recursive: true, force: true }).catch(() => undefined);
      staticDir = null;
    }
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = null;
    }
  }, 60000);

  test(
    "Codex agent survives daemon kill and restart, preserving conversation context",
    async () => {
      // Create isolated directories that persist across daemon restarts
      // NOTE: We use the default CODEX_HOME (~/.codex) for sessions because
      // Codex CLI needs its config for API authentication
      paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-home-restart-"));
      staticDir = await mkdtemp(path.join(tmpdir(), "paseo-static-restart-"));
      cwd = tmpCwd();

      // Use a unique secret that we'll verify after restart
      const secretPhrase = `DAEMON_RESTART_SECRET_${Date.now()}`;

      // === PHASE 1: Start daemon and create Codex agent with secret ===
      currentDaemon = await startDaemon({ paseoHome, staticDir });

      const agent = await currentDaemon.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        cwd,
        title: "Daemon Restart Test Agent",
        modeId: "full-access",
      });

      expect(agent.id).toBeTruthy();
      expect(agent.status).toBe("idle");

      // Ask the agent to remember the secret
      await currentDaemon.client.sendMessage(
        agent.id,
        `Remember this secret phrase: "${secretPhrase}". Just confirm you've remembered it with a short reply.`
      );

      const afterRemember = await currentDaemon.client.waitForAgentIdle(agent.id, 120000);
      expect(afterRemember.status).toBe("idle");
      expect(afterRemember.lastError).toBeUndefined();

      // Verify we got a confirmation and capture persistence handle
      const queue = currentDaemon.client.getMessageQueue();
      const confirmationMessages: string[] = [];
      for (const m of queue) {
        if (
          m.type === "agent_stream" &&
          m.payload.agentId === agent.id &&
          m.payload.event.type === "timeline"
        ) {
          const item = m.payload.event.item;
          if (item.type === "assistant_message" && item.text) {
            confirmationMessages.push(item.text);
          }
        }
      }
      expect(confirmationMessages.join("").length).toBeGreaterThan(0);

      // Get persistence handle for resuming after restart
      expect(afterRemember.persistence).toBeTruthy();
      const persistence = afterRemember.persistence as PersistenceHandle;
      expect(persistence.provider).toBe("codex");
      expect(persistence.sessionId).toBeTruthy();

      // Verify persistence metadata has conversationId
      const metadata = persistence.metadata as Record<string, unknown>;
      expect(metadata.conversationId).toBeTruthy();

      // Wait briefly to ensure Codex has flushed session files to disk
      await new Promise((r) => setTimeout(r, 500));

      // === PHASE 2: Kill the daemon (simulating crash/restart) ===
      await stopDaemon(currentDaemon);
      currentDaemon = null;

      // Verify agents.json was persisted
      const agentsJsonPath = path.join(paseoHome, "agents.json");
      expect(existsSync(agentsJsonPath)).toBe(true);

      // === PHASE 3: Start a NEW daemon with the SAME paseoHome ===
      currentDaemon = await startDaemon({ paseoHome, staticDir });

      // === PHASE 4: Resume the agent using the persistence handle ===
      const resumedAgent = await currentDaemon.client.resumeAgent(persistence);

      expect(resumedAgent.id).toBeTruthy();
      expect(resumedAgent.status).toBe("idle");
      expect(resumedAgent.provider).toBe("codex");
      expect(resumedAgent.cwd).toBe(cwd);

      // Wait a moment for history to load
      await new Promise((r) => setTimeout(r, 1000));

      // === PHASE 5: Ask about the secret to verify conversation context is preserved ===
      // This is the CRITICAL test: after daemon restart, the model should remember
      // the secret from the previous conversation. If it doesn't, the resume is broken.
      currentDaemon.client.clearMessageQueue();
      await currentDaemon.client.sendMessage(
        resumedAgent.id,
        "What was the secret phrase I asked you to remember earlier? Just reply with the exact phrase."
      );

      const afterMessage = await currentDaemon.client.waitForAgentIdle(resumedAgent.id, 120000);
      expect(afterMessage.status).toBe("idle");
      expect(afterMessage.lastError).toBeUndefined();

      // === PHASE 6: Verify the agent remembers the secret (proves context is preserved) ===
      const responseQueue = currentDaemon.client.getMessageQueue();
      const responseMessages: string[] = [];
      for (const m of responseQueue) {
        if (
          m.type === "agent_stream" &&
          m.payload.agentId === resumedAgent.id &&
          m.payload.event.type === "timeline"
        ) {
          const item = m.payload.event.item;
          if (item.type === "assistant_message" && item.text) {
            responseMessages.push(item.text);
          }
        }
      }
      const fullResponse = responseMessages.join("");

      // CRITICAL ASSERTION: The agent should remember the secret phrase from before daemon restart
      // This proves conversation context was properly restored via buildResumePrompt
      expect(fullResponse).toContain(secretPhrase);

      // Cleanup
      await currentDaemon.client.deleteAgent(resumedAgent.id);
    },
    300000 // 5 minute timeout
  );
});
