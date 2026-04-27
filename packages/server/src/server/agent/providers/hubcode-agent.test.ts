// Unit tests for HubcodeAgentClient.
//
// The Hubcode agent is a thin wrapper over ClaudeAgentClient — these tests
// focus on the wrapper-only behavior: env injection, combo→ANTHROPIC_MODEL
// routing, provider retagging on emitted events, and isAvailable() gating
// on the bundled binary. The Claude SDK itself is stubbed; we verify what
// the wrapper passes into it, not that it works.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types";
import { HubcodeAgentClient, HubcodeUpgradeRequiredError } from "./hubcode-agent";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function bundleResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface CreateSessionCall {
  config: AgentSessionConfig;
  launchContext: AgentLaunchContext | undefined;
}

function makeFakeClaudeSession(): AgentSession & { __push: (e: AgentStreamEvent) => void } {
  const subscribers: ((e: AgentStreamEvent) => void)[] = [];
  const session = {
    provider: "claude",
    id: "claude-session-1",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    run: vi.fn(async () => ({ runId: "r1", status: "completed" }) as never),
    startTurn: vi.fn(async () => ({ turnId: "t1" })),
    subscribe: vi.fn((cb: (e: AgentStreamEvent) => void) => {
      subscribers.push(cb);
      return () => {
        const ix = subscribers.indexOf(cb);
        if (ix >= 0) subscribers.splice(ix, 1);
      };
    }),
    streamHistory: vi.fn(async function* () {
      yield {
        type: "thread_started",
        provider: "claude",
        sessionId: "claude-session-1",
      } as AgentStreamEvent;
    }),
    getRuntimeInfo: vi.fn(async () => ({ provider: "claude", model: "x" }) as never),
    getAvailableModes: vi.fn(async () => []),
    getCurrentMode: vi.fn(async () => null),
    setMode: vi.fn(async () => {}),
    getPendingPermissions: vi.fn(() => []),
    respondToPermission: vi.fn(async () => {}),
    describePersistence: vi.fn(() => null),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    __push: (e: AgentStreamEvent) => subscribers.forEach((s) => s(e)),
  };
  return session as unknown as AgentSession & { __push: (e: AgentStreamEvent) => void };
}

function makeStubClaudeClient(opts: {
  onCreate?: (call: CreateSessionCall) => AgentSession;
} = {}) {
  const calls: CreateSessionCall[] = [];
  const stub = {
    provider: "claude" as const,
    capabilities: {} as never,
    isAvailable: vi.fn(async () => true),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(
      async (config: AgentSessionConfig, launchContext?: AgentLaunchContext) => {
        const call = { config, launchContext };
        calls.push(call);
        return opts.onCreate ? opts.onCreate(call) : makeFakeClaudeSession();
      },
    ),
    resumeSession: vi.fn(async () => makeFakeClaudeSession()),
  };
  return { stub, calls };
}

// ---------------------------------------------------------------------------
// isAvailable / getDiagnostic
// ---------------------------------------------------------------------------

describe("HubcodeAgentClient.isAvailable", () => {
  beforeEach(() => {
    delete process.env.HUBCODE_CLAUDE_BIN;
  });
  afterEach(() => {
    delete process.env.HUBCODE_CLAUDE_BIN;
  });

  it("returns false when HUBCODE_CLAUDE_BIN is unset", async () => {
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
    });
    expect(await client.isAvailable()).toBe(false);
  });

  it("returns false when the env points at a non-existent path", async () => {
    process.env.HUBCODE_CLAUDE_BIN = "/this/path/definitely/does/not/exist/claude";
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
    });
    expect(await client.isAvailable()).toBe(false);
  });

  it("returns true when the env points at an existing path", async () => {
    process.env.HUBCODE_CLAUDE_BIN = __filename;
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
    });
    expect(await client.isAvailable()).toBe(true);
  });
});

describe("HubcodeAgentClient.getDiagnostic", () => {
  beforeEach(() => {
    delete process.env.HUBCODE_CLAUDE_BIN;
    delete process.env.HUBCODE_CLAUDE_HOME;
  });
  afterEach(() => {
    delete process.env.HUBCODE_CLAUDE_BIN;
    delete process.env.HUBCODE_CLAUDE_HOME;
  });

  it("explains how to recover when the binary is missing", async () => {
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
    });
    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toMatch(/HUBCODE_CLAUDE_BIN is not set/);
  });

  it("reports the resolved binary + isolated CLAUDE_HOME when available", async () => {
    process.env.HUBCODE_CLAUDE_BIN = __filename;
    process.env.HUBCODE_CLAUDE_HOME = "/tmp/hubcode-claude-home";
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
    });
    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toContain(__filename);
    expect(diagnostic).toContain("/tmp/hubcode-claude-home");
  });
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe("HubcodeAgentClient.listModels", () => {
  beforeEach(() => {
    process.env.HUBCODE_SESSION_TOKEN = "test-token";
  });
  afterEach(() => {
    delete process.env.HUBCODE_SESSION_TOKEN;
  });

  it("returns combos from the bundle", async () => {
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
      fetch: async () =>
        bundleResponse({
          requiresUpgrade: false,
          planId: "plan_pro",
          apiKey: "or-key",
          baseUrl: "https://omniroute.example/v1",
          combos: [
            { comboId: "1", comboName: "hubcode-pro" },
            { comboId: "2", comboName: "hubcode-fast" },
          ],
        }),
    });
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(["hubcode-pro", "hubcode-fast"]);
  });

  it("returns the upgrade placeholder when requiresUpgrade is true", async () => {
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
      fetch: async () =>
        bundleResponse({
          requiresUpgrade: true,
          planId: "plan_free",
          apiKey: null,
          baseUrl: "https://omniroute.example/v1",
          combos: [],
        }),
    });
    const models = await client.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("__upgrade__");
  });

  it("returns [] when no session token is present", async () => {
    delete process.env.HUBCODE_SESSION_TOKEN;
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => makeStubClaudeClient().stub as never,
    });
    expect(await client.listModels()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createSession — env injection + Claude binary path
// ---------------------------------------------------------------------------

describe("HubcodeAgentClient.createSession", () => {
  beforeEach(() => {
    process.env.HUBCODE_SESSION_TOKEN = "test-token";
    process.env.HUBCODE_CLAUDE_BIN = __filename;
    process.env.HUBCODE_CLAUDE_HOME = "/tmp/hubcode-claude-home";
  });
  afterEach(() => {
    delete process.env.HUBCODE_SESSION_TOKEN;
    delete process.env.HUBCODE_CLAUDE_BIN;
    delete process.env.HUBCODE_CLAUDE_HOME;
  });

  function setupClient() {
    const factory = makeStubClaudeClient();
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => factory.stub as never,
      fetch: async () =>
        bundleResponse({
          requiresUpgrade: false,
          planId: "plan_pro",
          apiKey: "or-secret-key",
          baseUrl: "https://omniroute.example/v1",
          combos: [
            { comboId: "1", comboName: "hubcode-pro" },
            { comboId: "2", comboName: "hubcode-fast" },
          ],
        }),
    });
    return { client, calls: factory.calls };
  }

  it("injects ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL and isolated CLAUDE_CONFIG_DIR", async () => {
    const { client, calls } = setupClient();
    await client.createSession({
      provider: "hubcode",
      cwd: "/tmp",
      model: "hubcode-pro",
    });
    expect(calls).toHaveLength(1);
    const env = calls[0]!.launchContext?.env ?? {};
    // baseUrl had `/v1` stripped — Claude Code appends /v1/messages itself.
    expect(env.ANTHROPIC_BASE_URL).toBe("https://omniroute.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("or-secret-key");
    expect(env.ANTHROPIC_MODEL).toBe("hubcode-pro");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/hubcode-claude-home");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });

  it("forces the SDK to spawn the bundled binary, not the user's personal install", async () => {
    const { client, calls } = setupClient();
    await client.createSession({ provider: "hubcode", cwd: "/tmp" });
    expect(calls[0]!.config.extra?.claude?.pathToClaudeCodeExecutable).toBe(__filename);
  });

  it("rewrites provider:'hubcode' → 'claude' on the inner config (Claude SDK is the runtime)", async () => {
    const { client, calls } = setupClient();
    await client.createSession({ provider: "hubcode", cwd: "/tmp" });
    expect(calls[0]!.config.provider).toBe("claude");
  });

  it("falls back to the first combo when config.model is omitted", async () => {
    const { client, calls } = setupClient();
    await client.createSession({ provider: "hubcode", cwd: "/tmp" });
    expect(calls[0]!.launchContext?.env?.ANTHROPIC_MODEL).toBe("hubcode-pro");
  });

  it("throws HubcodeUpgradeRequiredError on free plans", async () => {
    const factory = makeStubClaudeClient();
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => factory.stub as never,
      fetch: async () =>
        bundleResponse({
          requiresUpgrade: true,
          planId: "plan_free",
          apiKey: null,
          baseUrl: "https://omniroute.example/v1",
          combos: [],
        }),
    });
    await expect(
      client.createSession({ provider: "hubcode", cwd: "/tmp" }),
    ).rejects.toBeInstanceOf(HubcodeUpgradeRequiredError);
  });

  it("throws when the bundled binary is missing", async () => {
    process.env.HUBCODE_CLAUDE_BIN = "/this/path/does/not/exist/claude";
    const { client } = setupClient();
    await expect(
      client.createSession({ provider: "hubcode", cwd: "/tmp" }),
    ).rejects.toThrow(/Hubcode requires the bundled Claude Code/);
  });
});

// ---------------------------------------------------------------------------
// Wrapper retags emitted events from claude → hubcode
// ---------------------------------------------------------------------------

describe("HubcodeAgentSession event retagging", () => {
  beforeEach(() => {
    process.env.HUBCODE_SESSION_TOKEN = "test-token";
    process.env.HUBCODE_CLAUDE_BIN = __filename;
  });
  afterEach(() => {
    delete process.env.HUBCODE_SESSION_TOKEN;
    delete process.env.HUBCODE_CLAUDE_BIN;
  });

  it("retags subscribe() callbacks", async () => {
    const innerSession = makeFakeClaudeSession();
    const factory = makeStubClaudeClient({ onCreate: () => innerSession });
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => factory.stub as never,
      fetch: async () =>
        bundleResponse({
          requiresUpgrade: false,
          planId: "plan_pro",
          apiKey: "k",
          baseUrl: "https://omniroute.example/v1",
          combos: [{ comboId: "1", comboName: "hubcode-pro" }],
        }),
    });
    const session = await client.createSession({ provider: "hubcode", cwd: "/tmp" });
    const received: AgentStreamEvent[] = [];
    session.subscribe((e) => received.push(e));
    innerSession.__push({ type: "turn_started", provider: "claude", turnId: "t1" });
    expect(received).toHaveLength(1);
    expect(received[0]!.provider).toBe("hubcode");
  });

  it("retags streamHistory() generator output", async () => {
    const factory = makeStubClaudeClient();
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => factory.stub as never,
      fetch: async () =>
        bundleResponse({
          requiresUpgrade: false,
          planId: "plan_pro",
          apiKey: "k",
          baseUrl: "https://omniroute.example/v1",
          combos: [{ comboId: "1", comboName: "hubcode-pro" }],
        }),
    });
    const session = await client.createSession({ provider: "hubcode", cwd: "/tmp" });
    const events: AgentStreamEvent[] = [];
    for await (const e of session.streamHistory()) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]!.provider).toBe("hubcode");
  });

  it("normalizes nested permission_requested.request.provider too", async () => {
    const innerSession = makeFakeClaudeSession();
    const factory = makeStubClaudeClient({ onCreate: () => innerSession });
    const client = new HubcodeAgentClient({
      claudeClientFactory: () => factory.stub as never,
      fetch: async () =>
        bundleResponse({
          requiresUpgrade: false,
          planId: "plan_pro",
          apiKey: "k",
          baseUrl: "https://omniroute.example/v1",
          combos: [{ comboId: "1", comboName: "hubcode-pro" }],
        }),
    });
    const session = await client.createSession({ provider: "hubcode", cwd: "/tmp" });
    const received: AgentStreamEvent[] = [];
    session.subscribe((e) => received.push(e));
    innerSession.__push({
      type: "permission_requested",
      provider: "claude",
      request: {
        id: "req-1",
        provider: "claude",
        kind: "tool",
        title: "Run bash",
        actions: [],
      } as never,
    });
    expect(received[0]!.provider).toBe("hubcode");
    expect(
      (received[0] as { request: { provider: string } }).request.provider,
    ).toBe("hubcode");
  });
});
