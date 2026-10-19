import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  asAgentManager,
  asAgentStorage,
  asDownloadTokenStore,
  asPushNotifications,
  createMessageReceiptsStub,
  createProviderSnapshotManagerStub,
  createTestCreationService,
} from "./test-utils/session-stubs.js";

describe("claude.auth.refresh.request RPC", () => {
  let tempClaudeDir: string;
  let prevClaudeConfigDir: string | undefined;

  beforeEach(() => {
    tempClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-session-test-"));
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempClaudeDir;
  });

  afterEach(() => {
    if (prevClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    fs.rmSync(tempClaudeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createTestSession(
    overrides: {
      terminalManager?: SessionOptions["terminalManager"];
      agentManager?: Partial<SessionOptions["agentManager"]>;
      agentStorage?: Partial<SessionOptions["agentStorage"]>;
      messages?: SessionOutboundMessage[];
    } = {},
  ) {
    const messages = overrides.messages ?? [];
    const logger = pino({ level: "silent" });

    const sessionOptions: SessionOptions = {
      messageReceipts: createMessageReceiptsStub(),
      creationService: createTestCreationService(),
      clientId: "test-client",
      onMessage: (message) => messages.push(message),
      onMessageToSource: (_source, message) => messages.push(message),
      onBinaryMessage: () => {},
      logger,
      downloadTokenStore: asDownloadTokenStore(),
      pushNotifications: asPushNotifications(),
      paseoHome: "/tmp/paseo-home",
      agentManager: asAgentManager({
        listAgents: () => [],
        listProviderSubagentActivity: () => [],
        subscribe: () => () => {},
        getAgent: vi.fn(),
        waitForAgentClose: vi.fn().mockResolvedValue(undefined),
        clearAgentAwsAuthRefreshRequired: vi.fn().mockResolvedValue(undefined),
        getAgentProviderEnv: vi.fn().mockReturnValue(undefined),
        isClaudeProvider: vi.fn((provider) => provider === "claude"),
        ...overrides.agentManager,
      }),
      agentStorage: asAgentStorage({
        get: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        ...overrides.agentStorage,
      }),
      projectRegistry: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        getOrCreateActiveByRoot: vi.fn(),
        upsert: vi.fn(),
        archive: vi.fn(),
        remove: vi.fn(),
        initialize: vi.fn(),
        existsOnDisk: vi.fn(),
      },
      workspaceRegistry: {
        get: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
      },
      scheduleService: {
        listSchedules: vi.fn().mockResolvedValue([]),
      } as unknown as SessionOptions["scheduleService"],
      checkoutDiffManager: {
        scheduleRefreshForCwd: vi.fn(),
      } as unknown as SessionOptions["checkoutDiffManager"],
      github: {
        invalidate: vi.fn(),
      } as unknown as SessionOptions["github"],
      workspaceGitService: {
        getCheckout: vi.fn(),
      } as unknown as SessionOptions["workspaceGitService"],
      daemonConfigStore: {
        get: vi.fn(() => ({
          mcp: { injectIntoAgents: false },
          providers: {},
        })),
        onChange: vi.fn(() => () => {}),
      } as unknown as SessionOptions["daemonConfigStore"],
      stt: null,
      tts: null,
      terminalManager: overrides.terminalManager ?? null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      permissions: OWNER_PERMISSIONS,
    };

    return {
      session: new Session(sessionOptions),
      messages,
      agentManager: sessionOptions.agentManager,
    };
  }

  it("handles dismiss action by clearing the agent flag", async () => {
    const clearMock = vi.fn().mockResolvedValue(undefined);
    const { session, messages } = createTestSession({
      agentManager: {
        clearAgentAwsAuthRefreshRequired: clearMock,
      },
    });

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-dismiss",
      agentId: "agent-1",
      action: "dismiss",
    });

    expect(clearMock).toHaveBeenCalledWith("agent-1");
    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-dismiss",
        agentId: "agent-1",
      },
    });
  });

  it("returns error when agent is not found on refresh", async () => {
    const { session, messages } = createTestSession({
      agentManager: {
        getAgent: vi.fn().mockReturnValue(null),
      },
      agentStorage: {
        get: vi.fn().mockResolvedValue(null),
      },
    });

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-not-found",
      agentId: "missing-agent",
      action: "refresh",
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "claude.auth.refresh.response",
        payload: expect.objectContaining({
          requestId: "req-not-found",
          error: expect.stringContaining("missing-agent"),
        }),
      }),
    );
  });

  it("returns error when terminalManager is unavailable", async () => {
    const mockAgent = {
      id: "agent-1",
      cwd: "/test/cwd",
      workspaceId: "ws-1",
      provider: "claude",
    };

    const { session, messages } = createTestSession({
      terminalManager: null,
      agentManager: {
        getAgent: vi.fn().mockReturnValue(mockAgent),
      },
    });

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-no-terminal",
      agentId: "agent-1",
      action: "refresh",
    });

    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-no-terminal",
        agentId: "agent-1",
        error: "Terminals are not available",
      },
    });
  });

  it("returns error when awsAuthRefresh is not configured in settings.json", async () => {
    const mockAgent = {
      id: "agent-1",
      cwd: "/test/cwd",
      workspaceId: "ws-1",
      provider: "claude",
    };

    const mockTerminalManager = {
      createTerminal: vi.fn(),
    } as unknown as SessionOptions["terminalManager"];

    const { session, messages } = createTestSession({
      terminalManager: mockTerminalManager,
      agentManager: {
        getAgent: vi.fn().mockReturnValue(mockAgent),
      },
    });

    fs.writeFileSync(
      path.join(tempClaudeDir, "settings.json"),
      JSON.stringify({ model: "claude-3-5-sonnet" }),
    );

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-unconfigured",
      agentId: "agent-1",
      action: "refresh",
    });

    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-unconfigured",
        agentId: "agent-1",
        error: `No AWS auth refresh command is configured in ${path.join(tempClaudeDir, "settings.json")} (awsAuthRefresh)`,
      },
    });
    expect(mockTerminalManager?.createTerminal).not.toHaveBeenCalled();
  });

  it("launches terminal with command and merged env when configured", async () => {
    const mockAgent = {
      id: "agent-1",
      cwd: "/test/cwd",
      workspaceId: "ws-1",
      provider: "claude",
    };

    const sendMock = vi.fn();
    const createTerminalMock = vi.fn().mockResolvedValue({
      id: "term-refresh-42",
      send: sendMock,
    });
    const mockTerminalManager = {
      createTerminal: createTerminalMock,
    } as unknown as SessionOptions["terminalManager"];

    const { session, messages } = createTestSession({
      terminalManager: mockTerminalManager,
      agentManager: {
        getAgent: vi.fn().mockReturnValue(mockAgent),
      },
    });

    const refreshCmd = "aws sso login --profile bedrock --no-browser --use-device-code";
    fs.writeFileSync(
      path.join(tempClaudeDir, "settings.json"),
      JSON.stringify({
        awsAuthRefresh: refreshCmd,
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "bedrock",
          AWS_REGION: "us-east-1",
        },
      }),
    );

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-success",
      agentId: "agent-1",
      action: "refresh",
    });

    expect(createTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/test/cwd",
        workspaceId: "ws-1",
        name: "AWS credentials refresh",
        title: "AWS credentials refresh",
        env: expect.objectContaining({
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "bedrock",
          AWS_REGION: "us-east-1",
        }),
      }),
    );
    expect(createTerminalMock.mock.calls[0]?.[0]?.command).toBeUndefined();
    expect(sendMock).toHaveBeenCalledWith({
      type: "input",
      data: `${refreshCmd}\r`,
    });

    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-success",
        agentId: "agent-1",
        terminalId: "term-refresh-42",
      },
    });
  });

  it("returns error when agent is not a claude agent", async () => {
    const mockAgent = {
      id: "agent-codex",
      cwd: "/test/cwd",
      workspaceId: "ws-1",
      provider: "codex",
    };

    const { session, messages } = createTestSession({
      agentManager: {
        getAgent: vi.fn().mockReturnValue(mockAgent),
      },
    });

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-wrong-provider",
      agentId: "agent-codex",
      action: "refresh",
    });

    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-wrong-provider",
        agentId: "agent-codex",
        error: "AWS credentials refresh is only supported for Claude agents (got codex)",
      },
    });
  });

  it("uses agent effective provider env for settings and terminal launch", async () => {
    const customConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-claude-config-"));
    const refreshCmd = "aws sso login --profile custom-profile --no-browser --use-device-code";
    fs.writeFileSync(
      path.join(customConfigDir, "settings.json"),
      JSON.stringify({
        awsAuthRefresh: refreshCmd,
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "us-west-2",
        },
      }),
    );

    const mockAgent = {
      id: "agent-custom-env",
      cwd: "/test/cwd",
      workspaceId: "ws-1",
      provider: "claude",
    };

    const sendMock = vi.fn();
    const createTerminalMock = vi.fn().mockResolvedValue({
      id: "term-custom-42",
      send: sendMock,
    });
    const mockTerminalManager = {
      createTerminal: createTerminalMock,
    } as unknown as SessionOptions["terminalManager"];

    const customEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: customConfigDir,
      AWS_PROFILE: "custom-profile",
    };

    const { session, messages } = createTestSession({
      terminalManager: mockTerminalManager,
      agentManager: {
        getAgent: vi.fn().mockReturnValue(mockAgent),
        getAgentProviderEnv: vi.fn().mockReturnValue(customEnv),
      },
    });

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-custom-env",
      agentId: "agent-custom-env",
      action: "refresh",
    });

    expect(createTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "AWS credentials refresh",
        title: "AWS credentials refresh",
        env: expect.objectContaining({
          CLAUDE_CONFIG_DIR: customConfigDir,
          AWS_PROFILE: "custom-profile",
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "us-west-2",
        }),
      }),
    );
    expect(createTerminalMock.mock.calls[0]?.[0]?.command).toBeUndefined();
    expect(sendMock).toHaveBeenCalledWith({
      type: "input",
      data: `${refreshCmd}\r`,
    });

    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-custom-env",
        agentId: "agent-custom-env",
        terminalId: "term-custom-42",
      },
    });

    fs.rmSync(customConfigDir, { recursive: true, force: true });
  });

  it("refreshes credentials for custom Claude providers extending claude", async () => {
    const customConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-claude-config-"));
    const refreshCmd = "aws sso login --profile bedrock-profile --no-browser --use-device-code";
    fs.writeFileSync(
      path.join(customConfigDir, "settings.json"),
      JSON.stringify({
        awsAuthRefresh: refreshCmd,
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "bedrock-profile",
        },
      }),
    );

    const mockAgent = {
      id: "agent-bedrock-1",
      cwd: "/test/cwd",
      workspaceId: "ws-1",
      provider: "bedrock",
    };

    const sendMock = vi.fn();
    const createTerminalMock = vi.fn().mockResolvedValue({
      id: "term-bedrock-42",
      send: sendMock,
    });
    const mockTerminalManager = {
      createTerminal: createTerminalMock,
    } as unknown as SessionOptions["terminalManager"];

    const customEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: customConfigDir,
      AWS_PROFILE: "bedrock-profile",
    };

    const isClaudeProviderMock = vi.fn(
      (provider) => provider === "claude" || provider === "bedrock",
    );
    const getAgentProviderEnvMock = vi.fn((_agentId, _provider) => customEnv);

    const { session, messages } = createTestSession({
      terminalManager: mockTerminalManager,
      agentManager: {
        getAgent: vi.fn().mockReturnValue(mockAgent),
        isClaudeProvider: isClaudeProviderMock,
        getAgentProviderEnv: getAgentProviderEnvMock,
      },
    });

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-bedrock-success",
      agentId: "agent-bedrock-1",
      action: "refresh",
    });

    expect(isClaudeProviderMock).toHaveBeenCalledWith("bedrock");
    expect(getAgentProviderEnvMock).toHaveBeenCalledWith("agent-bedrock-1", "bedrock");
    expect(createTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/test/cwd",
        workspaceId: "ws-1",
        name: "AWS credentials refresh",
        title: "AWS credentials refresh",
        env: expect.objectContaining({
          CLAUDE_CONFIG_DIR: customConfigDir,
          AWS_PROFILE: "bedrock-profile",
          CLAUDE_CODE_USE_BEDROCK: "1",
        }),
      }),
    );
    expect(createTerminalMock.mock.calls[0]?.[0]?.command).toBeUndefined();
    expect(sendMock).toHaveBeenCalledWith({
      type: "input",
      data: `${refreshCmd}\r`,
    });

    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-bedrock-success",
        agentId: "agent-bedrock-1",
        terminalId: "term-bedrock-42",
      },
    });

    fs.rmSync(customConfigDir, { recursive: true, force: true });
  });

  it("reports custom settings path when unconfigured in custom config dir", async () => {
    const customConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-empty-config-"));
    fs.writeFileSync(
      path.join(customConfigDir, "settings.json"),
      JSON.stringify({ model: "claude-3-5-sonnet" }),
    );

    const mockAgent = {
      id: "agent-custom-empty",
      cwd: "/test/cwd",
      workspaceId: "ws-1",
      provider: "bedrock",
      baseProvider: "claude",
    };

    const customEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: customConfigDir,
    };

    const { session, messages } = createTestSession({
      terminalManager: { createTerminal: vi.fn() } as unknown as SessionOptions["terminalManager"],
      agentManager: {
        getAgent: vi.fn().mockReturnValue(mockAgent),
        isClaudeProvider: vi.fn().mockReturnValue(true),
        getAgentProviderEnv: vi.fn().mockReturnValue(customEnv),
      },
    });

    await session.handleMessage({
      type: "claude.auth.refresh.request",
      requestId: "req-custom-empty",
      agentId: "agent-custom-empty",
      action: "refresh",
    });

    const expectedSettingsPath = path.join(customConfigDir, "settings.json");
    expect(messages).toContainEqual({
      type: "claude.auth.refresh.response",
      payload: {
        requestId: "req-custom-empty",
        agentId: "agent-custom-empty",
        error: `No AWS auth refresh command is configured in ${expectedSettingsPath} (awsAuthRefresh)`,
      },
    });

    fs.rmSync(customConfigDir, { recursive: true, force: true });
  });
});
