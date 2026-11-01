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

  test.each([
    ["reject-set-model", "Internal error: Requested model is unavailable"],
    ["reject-model-config", "Internal error: Requested model is unavailable"],
    ["missing-model-choice", "Model 'requested' is not a valid acp model config option"],
    ["no-model-selector", "does not expose ACP model selection"],
  ] as const)(
    "fails creation instead of running on the default model: %s",
    async (mode, message) => {
      await withFakeACPAgent(mode, async (command, cwd) => {
        const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
        await expect(
          client.createSession({ provider: "acp", cwd, model: "requested" }),
        ).rejects.toThrow(message);
      });
    },
  );

  test.each([
    ["reject-set-model", "Internal error: Requested model is unavailable"],
    ["reject-model-config", "Internal error: Requested model is unavailable"],
    ["missing-model-choice", "Model 'requested' is not a valid acp model config option"],
  ] as const)(
    "rejects a later model switch and preserves the current model: %s",
    async (mode, message) => {
      await withFakeACPAgent(mode, async (command, cwd) => {
        const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
        const session = await client.createSession({ provider: "acp", cwd });
        try {
          await expect(session.setModel("requested")).rejects.toThrow(message);
          expect((await session.getRuntimeInfo()).model).toBe("default");
        } finally {
          await session.close();
        }
      });
    },
  );

  test("uses config-option selection when set-model is not implemented", async () => {
    await withFakeACPAgent("config-model-only", async (command, cwd) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
      const session = await client.createSession({ provider: "acp", cwd, model: "requested" });
      try {
        expect((await session.getRuntimeInfo()).model).toBe("requested");
      } finally {
        await session.close();
      }
    });
  });

  test("fails resume when the requested model switch is rejected", async () => {
    await withFakeACPAgent("reject-set-model", async (command, cwd) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });
      const resumed = client.resumeSession(
        { provider: "acp", sessionId: "session-1", metadata: { cwd } },
        { model: "requested" },
      );
      await expect(resumed).rejects.toThrow("Internal error: Requested model is unavailable");
    });
  });
});

async function withFakeACPAgent(
  mode:
    | "reject-set-mode"
    | "reject-set-config-option"
    | "reject-set-model"
    | "reject-model-config"
    | "missing-model-choice"
    | "no-model-selector"
    | "config-model-only",
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
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      },
    });
    return;
  }

  if (message.method === "session/new" || message.method === "session/load") {
    write({
      id: message.id,
      result: {
        sessionId: "session-1",
        ...(mode === "reject-set-model" || mode === "config-model-only" ? {
          models: { currentModelId: "default", availableModels: [
            { modelId: "default", name: "Default" },
            { modelId: "requested", name: "Requested" },
          ] },
        } : {}),
        modes: {
          currentModeId: "agent",
          availableModes: [
            { id: "agent", name: "Agent" },
            { id: "plan", name: "Plan" },
          ],
        },
        configOptions: [
          ...(mode === "no-model-selector" ? [] : [{
            id: "model", name: "Model", category: "model", type: "select", currentValue: "default",
            options: [{ value: "default", name: "Default" },
              ...(mode === "missing-model-choice" ? [] : [{ value: "requested", name: "Requested" }])],
          }]),
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

  if (message.method === "session/set_model") {
    write({ id: message.id, error: mode === "reject-set-model"
      ? { code: -32603, message: "Internal error", data: { details: "Requested model is unavailable" } }
      : { code: -32601, message: "Method not found" } });
    return;
  }

  if (message.method === "session/set_config_option" && message.params.configId === "model") {
    if (mode === "reject-model-config") {
      write({ id: message.id, error: { code: -32603, message: "Internal error",
        data: { details: "Requested model is unavailable" } } });
    } else {
      write({ id: message.id, result: { configOptions: [{
        id: "model", name: "Model", category: "model", type: "select", currentValue: message.params.value,
        options: [{ value: "default", name: "Default" }, { value: "requested", name: "Requested" }],
      }] } });
    }
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
