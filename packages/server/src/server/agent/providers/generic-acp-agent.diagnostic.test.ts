import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { buildVersionProbeCommand, GenericACPAgentClient } from "./generic-acp-agent.js";
import type { SpawnedACPProcess } from "./acp-agent.js";

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

  test("reports command, binary, ACP initialize, session, models, and modes", async () => {
    class TestGenericACPAgentClient extends GenericACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          initialize: {
            protocolVersion: 1,
            agentInfo: { name: "Cursor Agent", version: "2026.05.09" },
            agentCapabilities: {},
          },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              models: {
                currentModelId: "composer-2[fast=true]",
                availableModels: [
                  {
                    modelId: "composer-2[fast=true]",
                    name: "Composer 2",
                  },
                ],
              },
              modes: {
                currentModeId: "ask",
                availableModes: [
                  { id: "agent", name: "Agent" },
                  { id: "ask", name: "Ask" },
                ],
              },
              configOptions: [],
            }),
          },
        } as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestGenericACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, "acp"],
      providerId: "cursor",
      label: "Cursor",
    });

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Cursor (ACP)");
    expect(diagnostic).toContain("Provider ID: cursor");
    expect(diagnostic).toContain(`Configured command: ${process.execPath} acp`);
    expect(diagnostic).toContain(`Launcher binary: ${process.execPath}`);
    expect(diagnostic).toContain(`Version command: ${process.execPath} --version`);
    expect(diagnostic).toContain("ACP initialize: ok (protocol 1, Cursor Agent 2026.05.09)");
    expect(diagnostic).toContain("ACP session/new: ok (session-1)");
    expect(diagnostic).toContain("Models: 1");
    expect(diagnostic).toContain("Modes: Agent, Ask");
    expect(diagnostic).toContain("Status: Available");
  });

  test("counts models and modes exposed as ACP config options", async () => {
    class ConfigOptionGenericACPAgentClient extends GenericACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          initialize: {
            protocolVersion: 1,
            agentInfo: { name: "Devin", version: "2026.5.6" },
            agentCapabilities: {},
          },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              models: null,
              modes: null,
              configOptions: [
                {
                  id: "mode",
                  name: "Session Mode",
                  category: "mode",
                  type: "select",
                  currentValue: "ask",
                  options: [
                    { value: "accept-edits", name: "Code" },
                    { value: "ask", name: "Ask" },
                  ],
                },
                {
                  id: "model",
                  name: "Model",
                  category: "model",
                  type: "select",
                  currentValue: "swe-1-6-slow",
                  options: [{ value: "swe-1-6-slow", name: "SWE-1.6 Slow" }],
                },
              ],
            }),
          },
        } as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new ConfigOptionGenericACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, "acp"],
      providerId: "devin",
      label: "Devin",
    });

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Models: 1");
    expect(diagnostic).toContain("Modes: Code, Ask");
  });

  test("reports ACP probe failures instead of falling back to no diagnostic", async () => {
    class FailingGenericACPAgentClient extends GenericACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        throw new Error("initialize timed out");
      }
    }

    const client = new FailingGenericACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, "acp"],
      providerId: "cursor",
      label: "Cursor",
    });

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Cursor (ACP)");
    expect(diagnostic).toContain("ACP initialize: Error - initialize timed out");
    expect(diagnostic).toContain("Status: Error (ACP probe failed: initialize timed out)");
  });
});
