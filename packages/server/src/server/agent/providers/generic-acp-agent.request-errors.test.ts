import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient request errors", () => {
  test("reports the agent's message when it rejects the configured mode", async () => {
    await withFakeACPAgent("reject-set-mode", async (command, cwd) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });

      const created = client.createSession({ provider: "acp", cwd, modeId: "plan" });

      await expect(created).rejects.toBeInstanceOf(Error);
      await expect(created).rejects.toThrow("Internal error: Mode plan is not allowed");
    });
  });

  test("reports the agent's message when it rejects the configured thinking option", async () => {
    await withFakeACPAgent("reject-set-config-option", async (command, cwd) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });

      const created = client.createSession({ provider: "acp", cwd, thinkingOptionId: "high" });

      await expect(created).rejects.toBeInstanceOf(Error);
      await expect(created).rejects.toThrow("Internal error: Effort high is not allowed");
    });
  });
});

async function withFakeACPAgent(
  mode: "reject-set-mode" | "reject-set-config-option",
  run: (command: [string, ...string[]], cwd: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-acp-request-errors-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run([process.execPath, scriptPath, mode], testDir);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

const fakeACPAgentScript = `
const readline = require("node:readline");

const mode = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      },
    });
    return;
  }

  if (message.method === "session/new") {
    write({
      id: message.id,
      result: {
        sessionId: "session-1",
        modes: {
          currentModeId: "agent",
          availableModes: [
            { id: "agent", name: "Agent" },
            { id: "plan", name: "Plan" },
          ],
        },
        configOptions: [
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
    });
    return;
  }

  if (message.method === "session/set_mode" && mode === "reject-set-mode") {
    write({
      id: message.id,
      error: { code: -32603, message: "Internal error", data: { details: "Mode plan is not allowed" } },
    });
    return;
  }

  if (message.method === "session/set_config_option" && mode === "reject-set-config-option") {
    write({
      id: message.id,
      error: { code: -32603, message: "Internal error", data: { details: "Effort high is not allowed" } },
    });
    return;
  }

  if (message.id !== undefined) {
    write({ id: message.id, result: {} });
  }
});
`;
