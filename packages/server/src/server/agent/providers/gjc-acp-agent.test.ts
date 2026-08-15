import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile, rm, stat } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";

import type {
  ClientSideConnection,
  LoadSessionResponse,
  McpServer,
} from "@agentclientprotocol/sdk";

import { createTestLogger } from "../../../test-utils/test-logger.js";

import {
  buildGjcLifecycleCloseCommand,
  buildGjcLifecycleCreateCommand,
  createGjcACPNewSessionStarter,
  createGjcACPProbeSessionCloser,
  GjcACPAgentClient,
  transformGjcConfigOptions,
  transformGjcModeId,
  transformGjcSessionResponse,
} from "./gjc-acp-agent.js";

describe("GjcACPAgentClient", () => {
  test("keeps GJC probe clients non-terminal while preserving prompt permission metadata", async () => {
    const initialize = vi.fn(async () => ({ agentCapabilities: {} }));
    const loadSession = vi.fn(
      async (): Promise<LoadSessionResponse> => ({
        sessionId: "loaded-session",
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
        models: {
          currentModelId: "openai-codex/gpt-5.5",
          availableModels: [
            {
              modelId: "openai-codex/gpt-5.5",
              name: "GPT-5.5",
              description: "GJC model",
            },
          ],
        },
        configOptions: [],
      }),
    );
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("session.create")) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              sessionId: "gjc-session-1",
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("session.close")) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              closed: true,
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected GJC command: ${args.join(" ")}`);
    });

    class TestGjcACPAgentClient extends GjcACPAgentClient {
      protected override async spawnTransport() {
        return {
          child: {
            kill: vi.fn(),
            exitCode: 0,
            signalCode: null,
          } as unknown as ChildProcessWithoutNullStreams,
          connection: {
            initialize,
            loadSession,
          } as unknown as ClientSideConnection,
          stderrChunks: [],
          spawnReady: Promise.resolve(),
          spawnError: new Promise<never>(() => undefined),
        };
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestGjcACPAgentClient({
      logger: createTestLogger(),
      command: ["gjc", "acp"],
      env: {
        GJC_LOG: "debug",
      },
      providerId: "gjc",
      label: "Gajae Code",
      providerParams: {
        supportsMcpServers: false,
      },
      execFile,
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/repo", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "acp",
          id: "openai-codex/gpt-5.5",
          label: "GPT-5.5",
          description: "GJC model",
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [
        {
          id: "default",
          label: "Default",
          description: undefined,
        },
      ],
    });

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
          _meta: {
            gjc: {
              permissionHandling: "prompt",
            },
          },
        },
      }),
    );
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "gjc-session-1",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(["sdk", "session", "raw", "global", "--op", "session.create"]),
    );
    expect(execFile.mock.calls[1]![1]).toEqual([
      "sdk",
      "session",
      "raw",
      "control",
      "gjc-session-1",
      "--op",
      "session.close",
      "--json-input",
      "{}",
      "--confirm",
      "--json",
      "--repo",
      "/repo",
    ]);
    expect(execFile.mock.calls[0]![2]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          GJC_LOG: "debug",
        }),
      }),
    );
  });

  test("uses the lifecycle readiness budget for diagnostic session probes", async () => {
    vi.useFakeTimers();
    try {
      let markStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let resolveCreate: (value: { stdout: string; stderr: string }) => void = () => undefined;
      const createResult = new Promise<{ stdout: string; stderr: string }>((resolve) => {
        resolveCreate = resolve;
      });
      const execFile = vi.fn(async (_file: string, args: string[]) => {
        if (args.includes("session.create")) {
          markStarted();
          return await createResult;
        }
        if (args.includes("session.close")) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                closed: true,
              },
            }),
            stderr: "",
          };
        }
        throw new Error(`Unexpected GJC command: ${args.join(" ")}`);
      });

      class TestGjcACPAgentClient extends GjcACPAgentClient {
        protected override async spawnTransport() {
          return {
            child: {
              kill: vi.fn(),
              exitCode: 0,
              signalCode: null,
            } as unknown as ChildProcessWithoutNullStreams,
            connection: {
              initialize: vi.fn(async () => ({ agentCapabilities: {} })),
              loadSession: vi.fn(async () => ({
                sessionId: "gjc-session-1",
                configOptions: [],
              })),
            } as unknown as ClientSideConnection,
            stderrChunks: [],
            spawnReady: Promise.resolve(),
            spawnError: new Promise<never>(() => undefined),
          };
        }
      }

      const client = new TestGjcACPAgentClient({
        logger: createTestLogger(),
        command: ["gjc-test", "acp"],
        execFile,
      });

      const diagnostic = client.getDiagnostic();
      let settled = false;
      void diagnostic.then(
        () => {
          settled = true;
          return undefined;
        },
        () => {
          settled = true;
          return undefined;
        },
      );
      await started;
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(40_000);
      resolveCreate({
        stdout: JSON.stringify({
          ok: true,
          result: {
            sessionId: "gjc-session-1",
          },
        }),
        stderr: "",
      });
      await expect(diagnostic).resolves.toEqual({
        diagnostic: expect.stringContaining(
          "ACP session/new: error: ACP session/new timed out after 60000ms",
        ),
      });
      expect(execFile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters GJC host-lifecycle plan mode from ACP mode state", () => {
    const transformed = transformGjcSessionResponse({
      sessionId: "session-1",
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
          {
            id: "https://agentclientprotocol.com/protocol/session-modes#plan",
            name: "Plan",
          },
        ],
      },
      configOptions: [],
    });

    expect(transformed.modes).toEqual({
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    });
  });

  test("filters GJC host-lifecycle plan mode from config mode options", () => {
    const transformed = transformGjcConfigOptions([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "plan",
        options: [
          { value: "default", name: "Default" },
          { value: "plan", name: "Plan" },
          {
            value: "https://agentclientprotocol.com/protocol/session-modes#plan",
            name: "Plan",
          },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "xhigh",
        options: [{ value: "xhigh", name: "Extra high" }],
      },
    ]);

    expect(transformed).toEqual([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
      {
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "xhigh",
        options: [{ value: "xhigh", name: "Extra high" }],
      },
    ]);
  });

  test("maps unsupported GJC mode updates to null", () => {
    expect(transformGjcModeId("plan")).toBeNull();
    expect(transformGjcModeId("default")).toBe("default");
  });

  test("builds a lifecycle create command from a wrapped gjc acp command", () => {
    const input = {
      cwd: "/repo",
      target: {
        path: "/repo",
      },
      readinessTimeoutMs: 60_000,
    };

    const command = buildGjcLifecycleCreateCommand(["bun", "x", "gjc", "acp"], "/repo", input);

    expect(command.command).toBe("bun");
    expect(command.args.slice(0, 6)).toEqual(["x", "gjc", "sdk", "session", "raw", "global"]);
    expect(command.args).toContain("session.create");
    const jsonInputIndex = command.args.indexOf("--json-input");
    expect(JSON.parse(command.args[jsonInputIndex + 1]!)).toEqual(input);
    expect(command.args.slice(-2)).toEqual(["--repo", "/repo"]);
  });

  test("builds a lifecycle close command from a wrapped gjc acp command", () => {
    const command = buildGjcLifecycleCloseCommand(
      ["bun", "x", "gjc", "acp"],
      "/repo",
      "gjc-session-1",
    );

    expect(command.command).toBe("bun");
    expect(command.args).toEqual([
      "x",
      "gjc",
      "sdk",
      "session",
      "raw",
      "control",
      "gjc-session-1",
      "--op",
      "session.close",
      "--json-input",
      "{}",
      "--confirm",
      "--json",
      "--repo",
      "/repo",
    ]);
  });

  test("creates a gjc lifecycle session from a private input file before loading ACP state", async () => {
    const lifecycleInputs: unknown[] = [];
    let lifecycleInputFilePath: string | null = null;
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const jsonInputFileIndex = args.indexOf("--json-input-file");
      expect(jsonInputFileIndex).toBeGreaterThan(-1);
      lifecycleInputFilePath = args[jsonInputFileIndex + 1] ?? null;
      if (!lifecycleInputFilePath) {
        throw new Error("Expected GJC lifecycle input file path");
      }
      expect((await stat(lifecycleInputFilePath)).mode & 0o777).toBe(0o600);
      lifecycleInputs.push(JSON.parse(await readFile(lifecycleInputFilePath, "utf8")));
      return {
        stdout: JSON.stringify({
          type: "broker_response",
          ok: true,
          result: {
            sessionId: "gjc-session-1",
            endpoint: {
              token: "endpoint-secret",
            },
          },
        }),
        stderr: "",
      };
    });
    const loadResponse = {} as LoadSessionResponse;
    const loadSession = vi.fn(async () => loadResponse);
    const runRequest = vi.fn(async <T>(request: () => Promise<T>) => await request());
    const registerProbeSession = vi.fn();
    const mcpServers: McpServer[] = [
      {
        type: "http",
        name: "hub",
        url: "https://hub.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer mcp-secret-token" }],
      },
    ];
    const starter = createGjcACPNewSessionStarter({
      command: ["gjc", "acp"],
      env: {
        GJC_LOG: "debug",
      },
      execFile,
    });

    const response = await starter({
      connection: {
        loadSession,
      } as unknown as ClientSideConnection,
      config: {
        provider: "gjc",
        cwd: "/repo",
      },
      mcpServers,
      runRequest,
      registerProbeSession,
    });

    expect(response).toEqual({
      sessionId: "gjc-session-1",
    });
    expect(execFile).toHaveBeenCalledWith(
      "gjc",
      expect.arrayContaining(["sdk", "session", "raw", "global"]),
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          GJC_LOG: "debug",
        }),
        timeout: 130_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      }),
    );
    const args = execFile.mock.calls[0]![1];
    expect(args).not.toContain("--json-input");
    expect(args.join(" ")).not.toContain("mcp-secret-token");
    expect(lifecycleInputs).toEqual([
      {
        cwd: "/repo",
        target: {
          path: "/repo",
        },
        readinessTimeoutMs: 60_000,
        mcpServers,
      },
    ]);
    if (!lifecycleInputFilePath) {
      throw new Error("Expected GJC lifecycle input file path");
    }
    await expect(access(lifecycleInputFilePath)).rejects.toThrow();
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "gjc-session-1",
      cwd: "/repo",
      mcpServers,
    });
    expect(registerProbeSession).toHaveBeenCalledWith({
      sessionId: "gjc-session-1",
    });
    expect(runRequest).toHaveBeenCalledTimes(1);
  });

  test("closes a gjc lifecycle session when the ACP load step fails", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          ok: true,
          result: {
            sessionId: "gjc-session-1",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          ok: true,
          result: {
            closed: true,
          },
        }),
        stderr: "",
      });
    const loadSession = vi.fn().mockRejectedValue(new Error("load failed"));
    const runRequest = vi.fn(async <T>(request: () => Promise<T>) => await request());
    const starter = createGjcACPNewSessionStarter({
      command: ["gjc", "acp"],
      execFile,
    });

    await expect(
      starter({
        connection: {
          loadSession,
        } as unknown as ClientSideConnection,
        config: {
          provider: "gjc",
          cwd: "/repo",
        },
        mcpServers: [],
        runRequest,
      }),
    ).rejects.toThrow("load failed");

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]![1]).toEqual([
      "sdk",
      "session",
      "raw",
      "control",
      "gjc-session-1",
      "--op",
      "session.close",
      "--json-input",
      "{}",
      "--confirm",
      "--json",
      "--repo",
      "/repo",
    ]);
  });

  test("closes a gjc lifecycle session when input cleanup fails after create", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          ok: true,
          result: {
            sessionId: "gjc-session-1",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          ok: true,
          result: {
            closed: true,
          },
        }),
        stderr: "",
      });
    const removeInputDirectory = vi.fn(async (path: string) => {
      await rm(path, { recursive: true, force: true });
      throw new Error("cleanup failed");
    });
    const loadSession = vi.fn();
    const runRequest = vi.fn(async <T>(request: () => Promise<T>) => await request());
    const registerProbeSession = vi.fn();
    const starter = createGjcACPNewSessionStarter({
      command: ["gjc", "acp"],
      execFile,
      removeInputDirectory,
    });

    await expect(
      starter({
        connection: {
          loadSession,
        } as unknown as ClientSideConnection,
        config: {
          provider: "gjc",
          cwd: "/repo",
        },
        mcpServers: [],
        runRequest,
        registerProbeSession,
      }),
    ).rejects.toThrow("GJC lifecycle input cleanup failed after session.create: cleanup failed");

    expect(removeInputDirectory).toHaveBeenCalledTimes(1);
    expect(loadSession).not.toHaveBeenCalled();
    expect(registerProbeSession).not.toHaveBeenCalled();
    expect(runRequest).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]![1]).toEqual([
      "sdk",
      "session",
      "raw",
      "control",
      "gjc-session-1",
      "--op",
      "session.close",
      "--json-input",
      "{}",
      "--confirm",
      "--json",
      "--repo",
      "/repo",
    ]);
  });

  test("preserves input cleanup failure details when lifecycle create fails", async () => {
    const createError = new Error("create failed");
    const cleanupError = new Error("cleanup failed");
    const execFile = vi.fn(async () => {
      throw createError;
    });
    const removeInputDirectory = vi.fn(async (path: string) => {
      await rm(path, { recursive: true, force: true });
      throw cleanupError;
    });
    const loadSession = vi.fn();
    const runRequest = vi.fn(async <T>(request: () => Promise<T>) => await request());
    const starter = createGjcACPNewSessionStarter({
      command: ["gjc", "acp"],
      execFile,
      removeInputDirectory,
    });

    let thrown: unknown;
    try {
      await starter({
        connection: {
          loadSession,
        } as unknown as ClientSideConnection,
        config: {
          provider: "gjc",
          cwd: "/repo",
        },
        mcpServers: [],
        runRequest,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "GJC lifecycle session.create failed: GJC lifecycle request failed and input cleanup failed: create failed; cleanup: cleanup failed",
    );
    expect((thrown as Error).cause).toBeInstanceOf(AggregateError);
    expect(((thrown as Error).cause as AggregateError).errors).toEqual([createError, cleanupError]);
    expect(removeInputDirectory).toHaveBeenCalledTimes(1);
    expect(loadSession).not.toHaveBeenCalled();
    expect(runRequest).not.toHaveBeenCalled();
  });

  test("closes a gjc probe lifecycle session after catalog use", async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        ok: true,
        result: {
          closed: true,
        },
      }),
      stderr: "",
    }));
    const closer = createGjcACPProbeSessionCloser({
      command: ["gjc", "acp"],
      env: {
        GJC_LOG: "debug",
      },
      execFile,
    });

    await closer({
      response: {
        sessionId: "gjc-session-1",
      },
      config: {
        provider: "gjc",
        cwd: "/repo",
      },
      mcpServers: [],
    });

    expect(execFile).toHaveBeenCalledWith(
      "gjc",
      [
        "sdk",
        "session",
        "raw",
        "control",
        "gjc-session-1",
        "--op",
        "session.close",
        "--json-input",
        "{}",
        "--confirm",
        "--json",
        "--repo",
        "/repo",
      ],
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          GJC_LOG: "debug",
        }),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      }),
    );
  });
});
