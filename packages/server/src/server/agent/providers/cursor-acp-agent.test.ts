import { afterEach, describe, expect, test, vi } from "vitest";

import type { SpawnedACPProcess, SessionStateResponse } from "./acp-agent.js";
import { CursorACPAgentClient, parseCursorAgentModelsOutput } from "./cursor-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../utils/spawn.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCursorAgentModelsOutput", () => {
  test("parses Cursor model list output and marks default model", () => {
    expect(
      parseCursorAgentModelsOutput(`
Available models

auto - Auto
composer-2-fast - Composer 2 Fast (default)
gpt-5.5-low - GPT-5.5 1M Low (current)

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`),
    ).toEqual([
      { provider: "acp", id: "auto", label: "Auto", isDefault: false },
      {
        provider: "acp",
        id: "composer-2-fast",
        label: "Composer 2 Fast",
        isDefault: true,
      },
      {
        provider: "acp",
        id: "gpt-5.5-low",
        label: "GPT-5.5 1M Low",
        isDefault: false,
      },
    ]);
  });

  test("falls back to first model as default when Cursor marks none", () => {
    expect(
      parseCursorAgentModelsOutput(`
Available models
composer-2 - Composer 2
gpt-5.5-low - GPT-5.5 1M Low
`),
    ).toEqual([
      { provider: "acp", id: "composer-2", label: "Composer 2", isDefault: true },
      { provider: "acp", id: "gpt-5.5-low", label: "GPT-5.5 1M Low", isDefault: false },
    ]);
  });
});

describe("CursorACPAgentClient model fallback", () => {
  class TestCursorACPAgentClient extends CursorACPAgentClient {
    constructor(options: {
      command?: [string, ...string[]];
      env?: Record<string, string>;
      response: SessionStateResponse;
    }) {
      super({
        logger: createTestLogger(),
        command: options.command ?? ["cursor-agent", "acp"],
        env: options.env,
      });
      this.response = options.response;
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

  test("uses cursor-agent models when Cursor ACP reports zero models", async () => {
    const execCommand = vi.spyOn(spawnUtils, "execCommand").mockResolvedValue({
      stdout: "Available models\ncomposer-2-fast - Composer 2 Fast (default)\n",
      stderr: "",
    });
    const client = new TestCursorACPAgentClient({
      response: { sessionId: "session-1", models: null, configOptions: [] },
    });

    const models = await client.listModels({ cwd: "/tmp/cursor", force: false });

    expect(models).toEqual([
      {
        provider: "acp",
        id: "composer-2-fast",
        label: "Composer 2 Fast",
        isDefault: true,
      },
    ]);
    expect(execCommand).toHaveBeenCalledWith(
      "cursor-agent",
      ["models"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  test("uses cursor-agent models for absolute cursor-agent commands", async () => {
    const execCommand = vi.spyOn(spawnUtils, "execCommand").mockResolvedValue({
      stdout: "Available models\ncomposer-2-fast - Composer 2 Fast (default)\n",
      stderr: "",
    });
    const client = new TestCursorACPAgentClient({
      command: ["/opt/cursor/bin/cursor-agent", "acp"],
      response: { sessionId: "session-1", models: null, configOptions: [] },
    });

    await expect(client.listModels({ cwd: "/tmp/cursor", force: false })).resolves.toEqual([
      {
        provider: "acp",
        id: "composer-2-fast",
        label: "Composer 2 Fast",
        isDefault: true,
      },
    ]);
    expect(execCommand).toHaveBeenCalledWith(
      "/opt/cursor/bin/cursor-agent",
      ["models"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  test("passes Cursor provider env to cursor-agent models fallback", async () => {
    const execCommand = vi.spyOn(spawnUtils, "execCommand").mockResolvedValue({
      stdout: "Available models\ncomposer-2-fast - Composer 2 Fast (default)\n",
      stderr: "",
    });
    const env = { CURSOR_AGENT_LOG: "debug" };
    const client = new TestCursorACPAgentClient({
      env,
      response: { sessionId: "session-1", models: null, configOptions: [] },
    });

    await client.listModels({ cwd: "/tmp/cursor", force: false });

    expect(execCommand).toHaveBeenCalledWith(
      "cursor-agent",
      ["models"],
      expect.objectContaining({ envOverlay: env }),
    );
  });

  test("does not run fallback when ACP returns models", async () => {
    const execCommand = vi.spyOn(spawnUtils, "execCommand");
    const client = new TestCursorACPAgentClient({
      response: {
        sessionId: "session-1",
        models: {
          currentModelId: "acp-model",
          availableModels: [{ modelId: "acp-model", name: "ACP Model", description: null }],
        },
        configOptions: [],
      },
    });

    await expect(client.listModels({ cwd: "/tmp/cursor", force: false })).resolves.toEqual([
      {
        provider: "acp",
        id: "acp-model",
        label: "ACP Model",
        description: undefined,
        isDefault: true,
        thinkingOptions: undefined,
        defaultThinkingOptionId: undefined,
      },
    ]);
    expect(execCommand).not.toHaveBeenCalled();
  });

  test("does not run fallback when command is not cursor-agent", async () => {
    const execCommand = vi.spyOn(spawnUtils, "execCommand");
    const client = new TestCursorACPAgentClient({
      command: ["other-agent", "acp"],
      response: { sessionId: "session-1", models: null, configOptions: [] },
    });

    await expect(client.listModels({ cwd: "/tmp/cursor", force: false })).resolves.toEqual([]);
    expect(execCommand).not.toHaveBeenCalled();
  });
});
