import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { buildVersionProbeCommand, GenericACPAgentClient } from "./generic-acp-agent.js";

const TEST_ACP_TIMEOUT_MS = 1_000;

describe("GenericACPAgentClient diagnostics", () => {
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
        client.fetchCatalog({ cwd: tmpdir(), force: true, timeoutMs: TEST_ACP_TIMEOUT_MS }),
      ).rejects.toThrow(`ACP catalog probe timed out after ${TEST_ACP_TIMEOUT_MS}ms`);

      const pid = Number(await readFile(pidPath, "utf8"));
      await expectProcessExit(pid);
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
  mode: "success" | "hang-session",
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
if (pidPath) {
  fs.writeFileSync(pidPath, String(process.pid));
}
const rl = readline.createInterface({ input: process.stdin });

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: message.params?.protocolVersion ?? 1,
      agentCapabilities: {},
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
  }
});
`;
