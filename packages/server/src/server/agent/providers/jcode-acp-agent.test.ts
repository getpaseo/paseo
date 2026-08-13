import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SpawnedACPProcess, SessionStateResponse } from "./acp-agent.js";
import { JcodeACPAgentClient } from "./jcode-acp-agent.js";

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jcode-acp-agent-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("JcodeACPAgentClient", () => {
  class TestJcodeACPAgentClient extends JcodeACPAgentClient {
    constructor(response: SessionStateResponse) {
      super({ logger: createTestLogger() });
      this.response = response;
    }

    private readonly response: SessionStateResponse;

    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(this.response),
        },
        initialize: { agentCapabilities: {} },
      } as SpawnedACPProcess;
    }

    protected override async closeProbe(): Promise<void> {}
  }

  test("wires the jcode provider id, ACP launch command, and capability flags", () => {
    class ExposedJcodeACPAgentClient extends JcodeACPAgentClient {
      launchCommand(): [string, ...string[]] {
        return this.defaultCommand;
      }
    }
    const client = new ExposedJcodeACPAgentClient({ logger: createTestLogger() });

    expect(client.provider).toBe("jcode");
    expect(client.launchCommand()).toEqual(["jcode", "acp"]);
    expect(client.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsSessionListing: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    });
  });

  test("reports unavailable when the jcode binary cannot be resolved", async () => {
    process.env.PATH = makeTempDir();
    const client = new JcodeACPAgentClient({ logger: createTestLogger() });

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  test("reports available when the jcode binary is on PATH", async () => {
    const binDir = makeTempDir();
    const binPath = path.join(binDir, "jcode");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    process.env.PATH = binDir;

    const client = new JcodeACPAgentClient({ logger: createTestLogger() });
    await expect(client.isAvailable()).resolves.toBe(true);
  });

  test("derives catalog models and empty modes from the ACP session response", async () => {
    const client = new TestJcodeACPAgentClient({
      sessionId: "session-jcode-test",
      models: {
        currentModelId: "jcode-model-a",
        availableModels: [{ modelId: "jcode-model-a", name: "Jcode Model A", description: null }],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "jcode-model-a",
          options: [{ value: "jcode-model-a", name: "Jcode Model A" }],
        },
      ],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/jcode", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "jcode",
          id: "jcode-model-a",
          label: "Jcode Model A",
          description: undefined,
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });

  test("reports zero models when the ACP session exposes none", async () => {
    const client = new TestJcodeACPAgentClient({
      sessionId: "session-jcode-empty",
      models: null,
      configOptions: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/jcode", force: false }),
    ).resolves.toEqual({ models: [], modes: [] });
  });
});
