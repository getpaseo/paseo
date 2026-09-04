import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { runProviderRefreshWithDeadline } from "../provider-refresh-deadline.js";
import { buildVersionProbeCommand, GenericACPAgentClient } from "./generic-acp-agent.js";

const TEST_ACP_TIMEOUT_MS = 1_000;

function parseInitializeTrace(content: string): Array<{ clientCapabilities: unknown }> {
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { clientCapabilities: unknown });
}

function historyBudgetClock(): () => number {
  let calls = 0;
  return () => (calls++ < 2 ? 0 : 60_001);
}

describe("GenericACPAgentClient diagnostics", () => {
  test("filters empty ACP sessions by replaying history and returns prompt previews", async () => {
    await withFakeACPAgent("history-list", async (scriptPath, mode, testDir) => {
      const closeTracePath = path.join(testDir, "session-close.jsonl");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", "", closeTracePath, testDir],
      });

      await expect(client.listImportableSessions({ limit: 1 })).resolves.toEqual([
        {
          providerHandleId: "conversation-session",
          cwd: testDir,
          title: "Conversation",
          firstPromptPreview: "First prompt",
          lastPromptPreview: "Last prompt",
          lastActivityAt: new Date("2026-09-04T20:00:00.000Z"),
        },
      ]);
      await expect(readFile(closeTracePath, "utf8")).resolves.toBe(
        `${JSON.stringify({ sessionId: "empty-session" })}\n${JSON.stringify({ sessionId: "conversation-session" })}\n`,
      );
    });
  });

  test("keeps a listed session visible when its ACP history cannot be loaded", async () => {
    await withFakeACPAgent("history-load-failure", async (scriptPath, mode, testDir) => {
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", "", "", testDir],
      });

      await expect(client.listImportableSessions({ limit: 1 })).resolves.toEqual([
        {
          providerHandleId: "stale-session",
          cwd: testDir,
          title: "Could still be real",
          firstPromptPreview: null,
          lastPromptPreview: null,
          lastActivityAt: new Date("2026-09-04T20:00:00.000Z"),
        },
      ]);
    });
  });

  test("keeps sessions with replayed conversation activity but no user text preview", async () => {
    await withFakeACPAgent("history-list", async (scriptPath, mode, testDir) => {
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", "", "", testDir],
      });

      const result = await client.listImportableSessions({ limit: 2 });

      expect(result).toMatchObject([
        { providerHandleId: "conversation-session" },
        { providerHandleId: "assistant-only-session" },
      ]);
      expect(result[1]).toMatchObject({
        firstPromptPreview: null,
        lastPromptPreview: null,
      });
    });
  });

  test("reuses ACP prompt previews while the listed session timestamp is unchanged", async () => {
    await withFakeACPAgent("history-list", async (scriptPath, mode, testDir) => {
      const loadTracePath = path.join(testDir, "session-load.jsonl");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", "", "", testDir, loadTracePath],
      });

      const first = await client.listImportableSessions({ limit: 1 });
      const second = await client.listImportableSessions({ limit: 1 });

      expect(second).toEqual(first);
      await expect(readFile(loadTracePath, "utf8")).resolves.toBe(
        `${JSON.stringify({ sessionId: "empty-session" })}\n${JSON.stringify({ sessionId: "conversation-session" })}\n`,
      );
    });
  });

  test("bounds history loads by scanLimit when every inspected session is empty", async () => {
    await withFakeACPAgent("history-list", async (scriptPath, mode, testDir) => {
      const closeTracePath = path.join(testDir, "session-close.jsonl");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", "", closeTracePath, testDir],
      });

      await expect(client.listImportableSessions({ limit: 1, scanLimit: 1 })).resolves.toEqual([]);
      await expect(readFile(closeTracePath, "utf8")).resolves.toBe(
        `${JSON.stringify({ sessionId: "empty-session" })}\n`,
      );
    });
  });

  test("bounds the total time spent loading inaccessible session histories", async () => {
    await withFakeACPAgent("history-load-failures", async (scriptPath, mode, testDir) => {
      const loadTracePath = path.join(testDir, "session-load.jsonl");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", "", "", testDir, loadTracePath],
        now: historyBudgetClock(),
      });

      const sessions = await client.listImportableSessions({ limit: 4 });

      expect(sessions).toMatchObject([
        { providerHandleId: "failed-session-1" },
        { providerHandleId: "failed-session-2" },
        { providerHandleId: "failed-session-3" },
        { providerHandleId: "failed-session-4" },
      ]);
      await expect(readFile(loadTracePath, "utf8")).resolves.toBe(
        `${JSON.stringify({ sessionId: "failed-session-1" })}\n`,
      );
    });
  });

  test("probes npx-backed agent packages instead of npx itself", () => {
    expect(buildVersionProbeCommand(["npx", "-y", "@google/gemini-cli@0.41.1", "--acp"])).toEqual({
      command: "npx",
      args: ["-y", "@google/gemini-cli@0.41.1", "--version"],
    });

    expect(buildVersionProbeCommand(["pnpm", "dlx", "@agent/foo@1.2.3", "--acp"])).toEqual({
      command: "pnpm",
      args: ["dlx", "@agent/foo@1.2.3", "--version"],
    });
  });

  test("reports command, binary, version command, and ACP phase rows", async () => {
    await withFakeACPAgent("success", async (scriptPath, mode) => {
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode],
        providerId: "cursor",
        label: "Cursor",
        diagnosticPhaseTimeoutMs: TEST_ACP_TIMEOUT_MS,
      });

      const { diagnostic } = await client.getDiagnostic();

      expect(diagnostic).toContain("Cursor (ACP)");
      expect(diagnostic).toContain("Provider ID: cursor");
      expect(diagnostic).toContain(`Configured command: ${process.execPath} ${scriptPath} success`);
      expect(diagnostic).toContain(`Launcher binary: ${process.execPath}`);
      expect(diagnostic).toContain(`Version command: ${process.execPath} --version`);
      expect(diagnostic).toContain("ACP spawn: ok");
      expect(diagnostic).toContain("ACP initialize: ok");
      expect(diagnostic).toContain("ACP session/new: ok");
      expect(diagnostic).toContain("models=1");
      expect(diagnostic).toContain("modes=1");
      expect(diagnostic).toContain("ACP cleanup: ok");
      expect(diagnostic).not.toContain("Status:");
    });
  });

  test("closes the native diagnostic probe session", async () => {
    await withFakeACPAgent("success", async (scriptPath, mode, testDir) => {
      const closeTracePath = path.join(testDir, "session-close.jsonl");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", "", closeTracePath],
        providerId: "custom-acp",
        label: "Custom ACP",
        diagnosticPhaseTimeoutMs: TEST_ACP_TIMEOUT_MS,
      });

      await client.getDiagnostic();

      await expect(readFile(closeTracePath, "utf8")).resolves.toContain(
        JSON.stringify({ sessionId: "session-1" }),
      );
    });
  });

  test("reports a hung ACP session/new phase without failing the diagnostic", async () => {
    await withFakeACPAgent("hang-session", async (scriptPath, mode) => {
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode],
        providerId: "grok",
        label: "Grok",
        diagnosticPhaseTimeoutMs: TEST_ACP_TIMEOUT_MS,
      });

      const { diagnostic } = await client.getDiagnostic();

      expect(diagnostic).toContain("Grok (ACP)");
      expect(diagnostic).toContain("Provider ID: grok");
      expect(diagnostic).toContain(`Version command: ${process.execPath} --version`);
      expect(diagnostic).toContain("ACP spawn: ok");
      expect(diagnostic).toContain("ACP initialize: ok");
      expect(diagnostic).toContain(
        `ACP session/new: error: ACP session/new timed out after ${TEST_ACP_TIMEOUT_MS}ms`,
      );
      expect(diagnostic).toContain("ACP cleanup: ok");
    });
  });

  test("terminates an ACP catalog probe when session/new times out", async () => {
    await withFakeACPAgent("hang-session", async (scriptPath, mode, testDir) => {
      const pidPath = path.join(testDir, "agent.pid");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, pidPath],
        providerId: "grok",
        label: "Grok",
      });

      await expect(
        runProviderRefreshWithDeadline({
          label: "Grok",
          timeoutMs: TEST_ACP_TIMEOUT_MS,
          operation: (context) =>
            client.fetchCatalog({ scope: "workspace", cwd: tmpdir(), force: true }, context),
        }),
      ).rejects.toThrow(
        `Timed out refreshing Grok after ${TEST_ACP_TIMEOUT_MS}ms; pending: session/new`,
      );

      const pid = Number(await readFile(pidPath, "utf8"));
      await expectProcessExit(pid);
    });
  });

  test("sends configured client capabilities in catalog and live session initialization", async () => {
    await withFakeACPAgent("success", async (scriptPath, mode, testDir) => {
      const initializeTracePath = path.join(testDir, "initialize.jsonl");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [process.execPath, scriptPath, mode, "", initializeTracePath],
        providerParams: {
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
        },
      });

      await client.fetchCatalog({ scope: "workspace", cwd: testDir, force: true });
      const session = await client.createSession({ provider: "acp", cwd: testDir });
      await session.close();

      const initializeRequests = parseInitializeTrace(await readFile(initializeTracePath, "utf8"));

      expect(initializeRequests).toHaveLength(2);
      expect(initializeRequests).toEqual([
        {
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
        },
        {
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
        },
      ]);
    });
  });

  test("reports a missing launcher without dropping the rest of the diagnostic", async () => {
    await withTempDir("paseo-missing-acp-agent-", async (testDir) => {
      const missingCommand = path.join(testDir, "missing-acp-agent");
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: [missingCommand, "--acp"],
        providerId: "grok",
        label: "Grok",
        diagnosticPhaseTimeoutMs: TEST_ACP_TIMEOUT_MS,
      });

      const { diagnostic } = await client.getDiagnostic();

      expect(diagnostic).toContain("Grok (ACP)");
      expect(diagnostic).toContain("Provider ID: grok");
      expect(diagnostic).toContain(`Configured command: ${missingCommand} --acp`);
      expect(diagnostic).toContain(`Launcher binary: ${missingCommand}`);
      expect(diagnostic).toContain("Resolved path: not found");
      expect(diagnostic).toContain("Version: unknown");
      expect(diagnostic).toContain(`Version command: ${missingCommand} --version`);
      expect(diagnostic).toContain("ACP spawn: error:");
      expect(diagnostic).toContain("not found");
    });
  });
});

async function withFakeACPAgent(
  mode:
    | "success"
    | "hang-session"
    | "history-list"
    | "history-load-failure"
    | "history-load-failures",
  run: (scriptPath: string, mode: string, testDir: string) => Promise<void>,
): Promise<void> {
  await withTempDir("paseo-acp-diagnostic-", async (testDir) => {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run(scriptPath, mode, testDir);
  });
}

async function withTempDir(prefix: string, run: (testDir: string) => Promise<void>): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await run(testDir);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected process ${pid} to exit`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

const fakeACPAgentScript = `
const fs = require("node:fs");
const readline = require("node:readline");

const mode = process.argv[2];
const pidPath = process.argv[3];
const initializeTracePath = process.argv[4];
const closeTracePath = process.argv[5];
const sessionCwd = process.argv[6];
const loadTracePath = process.argv[7];
if (pidPath) {
  fs.writeFileSync(pidPath, String(process.pid));
}
const rl = readline.createInterface({ input: process.stdin });

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (initializeTracePath) {
      fs.appendFileSync(
        initializeTracePath,
        JSON.stringify({ clientCapabilities: message.params?.clientCapabilities }) + "\\n",
      );
    }
    send(message.id, {
      protocolVersion: message.params?.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession:
          mode === "history-list" ||
          mode === "history-load-failure" ||
          mode === "history-load-failures",
        sessionCapabilities: { close: {}, list: {} },
      },
    });
    return;
  }

  if (message.method === "session/new") {
    if (mode === "hang-session") {
      return;
    }

    send(message.id, {
      sessionId: "session-1",
      modes: {
        availableModes: [{ id: "default", name: "Default", description: null }],
        currentModeId: "default",
      },
      models: {
        availableModels: [{ modelId: "fake-model", name: "Fake Model", description: null }],
        currentModelId: "fake-model",
      },
      configOptions: [],
    });
    return;
  }

  if (message.method === "session/close") {
    if (closeTracePath) {
      fs.appendFileSync(closeTracePath, JSON.stringify(message.params) + "\\n");
    }
    send(message.id, {});
    return;
  }

  if (message.method === "session/list" && mode === "history-list") {
    send(message.id, {
      sessions: [
        {
          sessionId: "empty-session",
          cwd: sessionCwd,
          title: "Empty",
          updatedAt: "2026-09-04T21:00:00.000Z",
        },
        {
          sessionId: "conversation-session",
          cwd: sessionCwd,
          title: "Conversation",
          updatedAt: "2026-09-04T20:00:00.000Z",
        },
        {
          sessionId: "assistant-only-session",
          cwd: sessionCwd,
          title: "Recovered conversation",
          updatedAt: "2026-09-04T19:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    return;
  }

  if (message.method === "session/list" && mode === "history-load-failure") {
    send(message.id, {
      sessions: [{
        sessionId: "stale-session",
        cwd: sessionCwd,
        title: "Could still be real",
        updatedAt: "2026-09-04T20:00:00.000Z",
      }],
      nextCursor: null,
    });
    return;
  }

  if (message.method === "session/list" && mode === "history-load-failures") {
    send(message.id, {
      sessions: [1, 2, 3, 4].map((number) => ({
        sessionId: "failed-session-" + number,
        cwd: sessionCwd,
        title: "Could still be real " + number,
        updatedAt: "2026-09-04T20:00:00.000Z",
      })),
      nextCursor: null,
    });
    return;
  }

  if (message.method === "session/load" && mode === "history-list") {
    if (loadTracePath) {
      fs.appendFileSync(
        loadTracePath,
        JSON.stringify({ sessionId: message.params.sessionId }) + "\\n",
      );
    }
    if (message.params.sessionId === "conversation-session") {
      for (const [messageId, text] of [["user-1", "First prompt"], ["user-2", "Last prompt"]]) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: message.params.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              messageId,
              content: { type: "text", text },
            },
          },
        }) + "\\n");
      }
    }
    if (message.params.sessionId === "assistant-only-session") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Recovered response" },
          },
        },
      }) + "\\n");
    }
    send(message.id, { modes: null, models: null, configOptions: [] });
    return;
  }

  if (
    message.method === "session/load" &&
    (mode === "history-load-failure" || mode === "history-load-failures")
  ) {
    if (loadTracePath) {
      fs.appendFileSync(
        loadTracePath,
        JSON.stringify({ sessionId: message.params.sessionId }) + "\\n",
      );
    }
    sendError(message.id, -32602, "stale session");
    return;
  }
});
`;
