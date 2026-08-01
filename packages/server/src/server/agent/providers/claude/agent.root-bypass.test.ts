import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeOptions, ClaudeQueryInput } from "./query.js";

// Claude Code refuses to start when the bypass capability is requested by a root process
// outside a deliberate sandbox, so requesting it unconditionally killed every session on a
// root-run daemon — including Ask mode. See issue #1582.

const ROOT_UID = 0;
const USER_UID = 1000;

function createQueryMock(): Query {
  const events: unknown[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "root-bypass-session",
      permissionMode: "default",
      model: "opus",
    },
    { type: "assistant", message: { content: "done" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

const sdkQueryFactory = vi.fn();
let capturedOptions: ClaudeOptions | undefined;

function createSession(uid: number, config: Partial<AgentSessionConfig> = {}) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
    getUid: () => uid,
  });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    ...config,
  });
}

beforeEach(() => {
  capturedOptions = undefined;
  sdkQueryFactory.mockReset();
  sdkQueryFactory.mockImplementation(({ options }: ClaudeQueryInput) => {
    capturedOptions = options;
    return createQueryMock();
  });
  vi.stubEnv("IS_SANDBOX", undefined);
  vi.stubEnv("CLAUDE_CODE_BUBBLEWRAP", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  sdkQueryFactory.mockReset();
});

test("drops the bypass launch capability when the daemon runs as root", async () => {
  const session = await createSession(ROOT_UID);

  try {
    await session.run("hello from root");
    expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(false);
    expect(capturedOptions?.permissionMode).toBe("default");
  } finally {
    await session.close();
  }
});

test("keeps the bypass launch capability when root runs inside a sandbox", async () => {
  vi.stubEnv("IS_SANDBOX", "1");
  const session = await createSession(ROOT_UID);

  try {
    await session.run("hello from a sandboxed root");
    expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(true);
  } finally {
    await session.close();
  }
});

test("reads the sandbox marker from the agent's own launch env, not the daemon's", async () => {
  const session = await createSession(ROOT_UID, {
    extra: { claude: { env: { IS_SANDBOX: "1" } } },
  });

  try {
    await session.run("hello from a per-agent sandbox");
    expect(capturedOptions?.env?.IS_SANDBOX).toBe("1");
    expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(true);
  } finally {
    await session.close();
  }
});

test("keeps the bypass launch capability for a non-root daemon", async () => {
  const session = await createSession(USER_UID);

  try {
    await session.run("hello from a normal user");
    expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(true);
  } finally {
    await session.close();
  }
});

test("ignores a bypass capability forced through extra.claude on a root daemon", async () => {
  const session = await createSession(ROOT_UID, {
    extra: {
      claude: { allowDangerouslySkipPermissions: true, permissionMode: "bypassPermissions" },
    },
  });

  try {
    await session.run("hello from a crafted client");
    expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(false);
    expect(capturedOptions?.permissionMode).toBe("default");
  } finally {
    await session.close();
  }
});

test("rejects switching to bypass mode when the daemon runs as root", async () => {
  const session = await createSession(ROOT_UID);

  try {
    await expect(session.setMode("bypassPermissions")).rejects.toThrow(
      "Claude Bypass mode cannot be used while Paseo runs as root",
    );
    expect(sdkQueryFactory).not.toHaveBeenCalled();
  } finally {
    await session.close();
  }
});

test("rejects launching a bypass-mode session when the daemon runs as root", async () => {
  const session = await createSession(ROOT_UID, { modeId: "bypassPermissions" });

  try {
    await expect(session.run("hello from root")).rejects.toThrow(
      "Claude Bypass mode cannot be used while Paseo runs as root",
    );
    expect(sdkQueryFactory).not.toHaveBeenCalled();
  } finally {
    await session.close();
  }
});

test("stops offering Bypass mode to a root daemon", async () => {
  const session = await createSession(ROOT_UID);

  try {
    const modeIds = (await session.getAvailableModes()).map((mode) => mode.id);
    expect(modeIds).not.toContain("bypassPermissions");
    expect(modeIds).toContain("default");
  } finally {
    await session.close();
  }
});

test("offers Bypass mode to a non-root daemon", async () => {
  const session = await createSession(USER_UID);

  try {
    const modeIds = (await session.getAvailableModes()).map((mode) => mode.id);
    expect(modeIds).toContain("bypassPermissions");
  } finally {
    await session.close();
  }
});

test("keeps Bypass out of the provider catalog for a root daemon", async () => {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
    getUid: () => ROOT_UID,
    // Keep the catalog off the host: no `claude --version` spawn, no real config dir read.
    resolveVersion: async () => "2.1.220",
    configDir: join(tmpdir(), "paseo-root-bypass-test-config"),
  });

  const catalog = await client.fetchCatalog({ scope: "global", force: false });

  expect(catalog.modes.map((mode) => mode.id)).not.toContain("bypassPermissions");
});
