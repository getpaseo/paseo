import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";

function isCodexInstalled(): boolean {
  try {
    return execFileSync("which", ["codex"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

function sse(events: unknown[]): string {
  return events
    .map((event) => {
      const type =
        typeof event === "object" && event !== null && "type" in event
          ? String((event as { type: unknown }).type)
          : "message";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function assistantMessageSse(text: string): string {
  return sse([
    { type: "response.created", response: { id: "resp-1" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "msg-1",
        content: [{ type: "output_text", text }],
      },
    },
    { type: "response.completed", response: { id: "resp-1" } },
  ]);
}

async function startMockResponsesServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.end(assistantMessageSse("archived turn"));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address for mock responses server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function writeMockCodexConfig(codexHome: string, serverUrl: string): void {
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `
model = "mock-model"
approval_policy = "on-request"
sandbox_mode = "read-only"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "${serverUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
  );
}

/**
 * Codex app-servers this test process spawned. `spawnProcess` detaches them, so
 * the parent link is the only handle back: a released app-server leaves this
 * list empty, a retained one keeps its pid in it.
 */
function listOwnedAppServers(): number[] {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  const owned: number[] = [];
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, args] = match;
    if (Number(ppid) === process.pid && /\bapp-server\b/.test(args)) {
      owned.push(Number(pid));
    }
  }
  return owned;
}

async function settledAppServers(timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let owned = listOwnedAppServers();
  while (owned.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    owned = listOwnedAppServers();
  }
  return owned;
}

describe("Codex archived history read (local e2e)", () => {
  test.runIf(isCodexInstalled())(
    "leaves the archived native thread untouched and releases the temporary app-server",
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-archived-history-cwd-"));
      const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-archived-history-home-"));
      const mockServer = await startMockResponsesServer();
      const logger = createTestLogger();
      const storage = new AgentStorage(path.join(cwd, "agents"), logger);
      const client = new CodexAppServerAgentClient(logger);
      const manager = new AgentManager({
        clients: { codex: client },
        registry: storage,
        logger,
      });
      const listNativeThreads = async () =>
        (await client.listImportableSessions({ limit: 20 })).map(
          (session) => session.providerHandleId,
        );

      try {
        writeMockCodexConfig(codexHome, mockServer.url);
        vi.stubEnv("CODEX_HOME", codexHome);

        // A real Codex thread carrying real persisted history.
        const created = await manager.createAgent(
          { provider: "codex", cwd, modeId: "auto", model: "mock-model" },
          undefined,
          { workspaceId: undefined },
        );
        const agentId = created.id;
        await manager.runAgent(agentId, "remember this turn");
        const handle = manager.getAgent(agentId)?.persistence;
        const threadId = handle?.sessionId;
        expect(threadId).toBeTruthy();
        expect(await listNativeThreads()).toContain(threadId);

        await manager.archiveAgent(agentId);
        // `archiveAgentUnlocked` syncs the native archive before it closes the
        // runtime, so `thread/archive` loses to the thread's own writer lock and
        // the best-effort sync swallows it. Archive again now that the runtime is
        // gone, so this test observes a genuinely archived native thread.
        await client.archiveNativeSession(handle!);
        expect(await listNativeThreads()).not.toContain(threadId);
        expect(await settledAppServers()).toEqual([]);

        const snapshot = await ensureAgentLoaded(agentId, {
          agentManager: manager,
          agentStorage: storage,
          logger,
        });

        // The history really was read...
        expect(snapshot.id).toBe(agentId);
        expect(manager.getTimeline(agentId).length).toBeGreaterThan(0);

        // ...the temporary app-server it used is gone...
        expect(await settledAppServers(), "a history read must not retain its app-server").toEqual(
          [],
        );

        // ...and the native thread is still archived, never resumed or unarchived.
        expect(
          await listNativeThreads(),
          "a history read must leave the native thread archived",
        ).not.toContain(threadId);
        await settledAppServers();
      } finally {
        for (const pid of listOwnedAppServers()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        await storage.flush();
        vi.unstubAllEnvs();
        await mockServer.close();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
    120_000,
  );
  test.runIf(isCodexInstalled())(
    "does not resume a native thread the Paseo archive left active",
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-active-history-cwd-"));
      const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-active-history-home-"));
      const mockServer = await startMockResponsesServer();
      const logger = createTestLogger();
      const storage = new AgentStorage(path.join(cwd, "agents"), logger);
      const client = new CodexAppServerAgentClient(logger);
      const manager = new AgentManager({
        clients: { codex: client },
        registry: storage,
        logger,
      });
      const listNativeThreads = async () =>
        (await client.listImportableSessions({ limit: 20 })).map(
          (session) => session.providerHandleId,
        );

      try {
        writeMockCodexConfig(codexHome, mockServer.url);
        vi.stubEnv("CODEX_HOME", codexHome);

        const created = await manager.createAgent(
          { provider: "codex", cwd, modeId: "auto", model: "mock-model" },
          undefined,
          { workspaceId: undefined },
        );
        const agentId = created.id;
        await manager.runAgent(agentId, "remember this turn");
        const handle = manager.getAgent(agentId)?.persistence;
        const threadId = handle?.sessionId;
        expect(threadId).toBeTruthy();

        // The ordinary archive path syncs the native archive while the runtime
        // still owns the thread's writer, so `thread/archive` loses and the
        // best-effort sync swallows it. The Paseo record is archived while the
        // native thread stays active — the state a history read actually meets.
        await manager.archiveAgent(agentId);
        expect(await listNativeThreads()).toContain(threadId);
        expect(await settledAppServers()).toEqual([]);

        await ensureAgentLoaded(agentId, {
          agentManager: manager,
          agentStorage: storage,
          logger,
        });
        expect(manager.getTimeline(agentId).length).toBeGreaterThan(0);

        // Codex refuses to archive a thread that has an active writer. A read-only
        // history pass takes no writer, so this succeeds; a `thread/resume` would
        // have claimed one and made it fail.
        await expect(
          client.archiveNativeSession(handle!),
          "a history read must not claim the native thread's writer",
        ).resolves.toBeUndefined();

        expect(await settledAppServers(), "a history read must not retain its app-server").toEqual(
          [],
        );
      } finally {
        for (const pid of listOwnedAppServers()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        await storage.flush();
        vi.unstubAllEnvs();
        await mockServer.close();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
