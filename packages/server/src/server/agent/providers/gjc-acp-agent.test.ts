import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ClientSideConnection, LoadSessionResponse } from "@agentclientprotocol/sdk";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  genericConstructorOptions: [] as unknown[],
}));

vi.mock("./generic-acp-agent.js", () => ({
  GenericACPAgentClient: class GenericACPAgentClient {
    readonly provider = "acp";

    constructor(options: unknown) {
      mockState.genericConstructorOptions.push(options);
    }
  },
}));

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
  beforeEach(() => {
    mockState.genericConstructorOptions = [];
  });

  test("enables Paseo terminal execution and prompt permission handling for GJC ACP", () => {
    const _client = new GjcACPAgentClient({
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
    });
    void _client;

    expect(mockState.genericConstructorOptions).toEqual([
      {
        logger: expect.any(Object),
        command: ["gjc", "acp"],
        env: {
          GJC_LOG: "debug",
        },
        providerId: "gjc",
        label: "Gajae Code",
        providerParams: {
          supportsMcpServers: false,
        },
        clientCapabilities: {
          terminal: true,
        },
        clientCapabilityMeta: {
          gjc: {
            permissionHandling: "prompt",
          },
        },
        sessionResponseTransformer: expect.any(Function),
        configOptionsTransformer: expect.any(Function),
        modeIdTransformer: expect.any(Function),
        newSessionStarter: expect.any(Function),
        probeSessionCloser: expect.any(Function),
      },
    ]);
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

  test("creates a gjc lifecycle session with extended readiness before loading ACP state", async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        type: "broker_response",
        ok: true,
        result: {
          sessionId: "gjc-session-1",
          endpoint: {
            token: "secret-token",
          },
        },
      }),
      stderr: "",
    }));
    const loadResponse = {} as LoadSessionResponse;
    const loadSession = vi.fn(async () => loadResponse);
    const runRequest = vi.fn(async <T>(request: () => Promise<T>) => await request());
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
      mcpServers: [],
      runRequest,
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
    const jsonInput = JSON.parse(args[args.indexOf("--json-input") + 1]!);
    expect(jsonInput).toEqual({
      cwd: "/repo",
      target: {
        path: "/repo",
      },
      readinessTimeoutMs: 60_000,
    });
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "gjc-session-1",
      cwd: "/repo",
      mcpServers: [],
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
