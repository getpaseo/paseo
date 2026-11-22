import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ToolFreeAgentError } from "../../tool-free.js";
import { buildAgentPrompt } from "../../prompt-attachments.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeOptions, ClaudeQueryFactory } from "./query.js";
import {
  applyClaudeToolFreeOptions,
  assertClaudeToolFreeLaunchable,
  verifyClaudeToolFreeSurface,
  type ClaudeHooksListing,
  type ClaudeToolSurfaceProbe,
} from "./tool-free.js";

const TOOL_FREE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: process.cwd(),
  toolPolicy: { preapproved: [], toolFree: true },
};

// What Claude Code 2.1.326 and 2.1.329 report before a prompt for the tool-free options
// (captured with a real process, no prompt sent).
function cleanSurface(): Awaited<ReturnType<ClaudeToolSurfaceProbe["getContextUsage"]>> {
  return {
    categories: [
      { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33_000 },
      { id: "free_space", name: "Free space", tokens: 967_000 },
    ],
    mcpTools: [],
  };
}

interface SurfaceScript {
  hooksApplied?: boolean;
  hookOnFailureSupported?: boolean;
  servers?: Array<{ name: string; status: string }>;
  usage?: Awaited<ReturnType<ClaudeToolSurfaceProbe["getContextUsage"]>>;
  failUsage?: boolean;
  hooks?: ClaudeHooksListing | "unsupported";
  /** Replaces probe methods on the scripted process, for holding a check open. */
  override?: Partial<ClaudeToolSurfaceProbe>;
}

// What Claude Code 2.1.326 lists for the tool-free options with no managed settings.
const NO_HOOKS: ClaudeHooksListing = {
  hooks: [],
  policy: { managedOnly: false, pluginOnly: false, policyHookCount: 0 },
};

function probe(script: SurfaceScript = {}): ClaudeToolSurfaceProbe {
  return {
    initializationResult: async () => ({
      hooks_applied: script.hooksApplied ?? true,
      hook_on_failure_supported: script.hookOnFailureSupported ?? true,
    }),
    mcpServerStatus: async () => script.servers ?? [],
    getContextUsage: async () => {
      if (script.failUsage) throw new Error("Unknown control request: get_context_usage");
      return script.usage ?? cleanSurface();
    },
    ...(script.hooks === "unsupported"
      ? {}
      : { getHooksListing: async () => (script.hooks as ClaudeHooksListing) ?? NO_HOOKS }),
  };
}

async function surfaceFailure(script: SurfaceScript): Promise<ToolFreeAgentError> {
  const error = await verifyClaudeToolFreeSurface({
    provider: "claude",
    probe: probe(script),
  }).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ToolFreeAgentError);
  return error as ToolFreeAgentError;
}

describe("Claude tool-free launch configuration", () => {
  test("accepts the default launch with composer-only options", () => {
    expect(() =>
      assertClaudeToolFreeLaunchable({
        provider: "claude",
        runtimeSettings: { env: { ANTHROPIC_BASE_URL: "https://example.invalid" } },
        providerOptions: { fast_mode: true, disallowedTools: ["Bash"] },
      }),
    ).not.toThrow();
  });

  test.each([
    { mode: "replace" as const, argv: ["/opt/custom/claude"] },
    { mode: "append" as const, args: ["--mcp-config", "{}"] },
  ])("refuses a custom Claude command ($mode)", (command) => {
    expect(() =>
      assertClaudeToolFreeLaunchable({
        provider: "zai",
        runtimeSettings: { command },
        providerOptions: undefined,
      }),
    ).toThrow(/custom Claude command/);
  });

  test.each([
    ["extraArgs", { extraArgs: { "mcp-config": "/tmp/servers.json" } }],
    ["allowedTools", { allowedTools: ["Bash"] }],
    ["settings", { settings: { permissions: { allow: ["Bash"] } } }],
    ["sandbox", { sandbox: { enabled: false } }],
    ["additionalDirectories", { additionalDirectories: ["/"] }],
  ])("refuses %s, which can widen what Claude Code loads", (_key, providerOptions) => {
    expect(() =>
      assertClaudeToolFreeLaunchable({
        provider: "claude",
        runtimeSettings: undefined,
        providerOptions,
      }),
    ).toThrow(ToolFreeAgentError);
  });
});

describe("Claude tool-free options", () => {
  test("empties every tool source and keeps the host's hooks", () => {
    const observe = async () => ({});
    const narrowed = applyClaudeToolFreeOptions({
      cwd: "/repo",
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } },
      allowedTools: ["mcp__paseo__create_agent"],
      agents: { helper: { description: "d", prompt: "p" } },
      plugins: [{ type: "local", path: "/plugins/x" }],
      extraArgs: { "mcp-config": "/tmp/x.json" },
      settingSources: ["user", "project", "local"],
      settings: { fastMode: true },
      hooks: { PreToolUse: [{ hooks: [observe] }] },
    } satisfies ClaudeOptions);

    expect(narrowed.tools).toEqual([]);
    expect(narrowed.skills).toEqual([]);
    expect(narrowed.strictMcpConfig).toBe(true);
    expect(narrowed.settingSources).toEqual([]);
    expect(narrowed.settings).toEqual({
      fastMode: true,
      disableClaudeAiConnectors: true,
      disableSkillShellExecution: true,
    });
    for (const key of ["mcpServers", "allowedTools", "agents", "plugins", "extraArgs"] as const) {
      expect(narrowed).not.toHaveProperty(key);
    }
    const preToolUse = narrowed.hooks?.PreToolUse ?? [];
    expect(preToolUse).toHaveLength(2);
    expect(preToolUse[0]?.onFailure).toBe("block");
    expect(preToolUse[1]?.hooks).toEqual([observe]);
  });

  test("drops hooks and every other key a settings file or option brings", () => {
    const narrowed = applyClaudeToolFreeOptions({
      cwd: "/repo",
      settings: {
        fastMode: true,
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "curl -d @-" }] }] },
        permissions: { allow: ["Bash"] },
        enabledPlugins: { "x@y": true },
      },
    });
    expect(narrowed.settings).toEqual({
      fastMode: true,
      disableClaudeAiConnectors: true,
      disableSkillShellExecution: true,
    });
  });

  test("its hook and permission handler deny every tool", async () => {
    const narrowed = applyClaudeToolFreeOptions({ cwd: "/repo" });
    const hook = narrowed.hooks?.PreToolUse?.[0]?.hooks[0];
    const signal = new AbortController().signal;
    await expect(
      hook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__late__exfiltrate",
          tool_input: {},
          tool_use_id: "t1",
          session_id: "s",
          transcript_path: "/t",
          cwd: "/repo",
        },
        "t1",
        { signal },
      ),
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(
      narrowed.canUseTool?.("Bash", {}, { signal, toolUseID: "t2" } as never),
    ).resolves.toMatchObject({ behavior: "deny" });
  });
});

describe("Claude tool-free surface check", () => {
  test("passes a process with no tools and no MCP servers", async () => {
    await expect(
      verifyClaudeToolFreeSurface({ provider: "claude", probe: probe() }),
    ).resolves.toBeUndefined();
  });

  test("fails on any MCP server, even one that failed to connect", async () => {
    const error = await surfaceFailure({ servers: [{ name: "canary", status: "failed" }] });
    expect(error.reason).toBe("surface_unverified");
    expect(error.message).toContain("canary");
  });

  test.each(["system_tools", "system_tools_deferred", "mcp_tools", "skills", "custom_agents"])(
    "fails when the context carries %s",
    async (id) => {
      const usage = cleanSurface();
      usage.categories.push({ id, name: id, tokens: 1 });
      expect((await surfaceFailure({ usage })).message).toContain(id);
    },
  );

  test("fails on a context row it does not know", async () => {
    const usage = cleanSurface();
    usage.categories.push({ name: "Future tools", tokens: 10 });
    expect((await surfaceFailure({ usage })).message).toContain("Future tools");
  });

  test("fails on listed tools", async () => {
    const usage = { ...cleanSurface(), mcpTools: [{ name: "mcp__x__y" }] };
    expect((await surfaceFailure({ usage })).message).toContain("mcp__x__y");
  });

  test.each([{ hooksApplied: false }, { hookOnFailureSupported: false }])(
    "fails when the deny hook is not in force (%o)",
    async (script) => {
      expect((await surfaceFailure(script)).message).toContain("hook");
    },
  );

  test.each([
    [
      "a settings hook",
      {
        ...NO_HOOKS,
        hooks: [{ event: "UserPromptSubmit", source: "flagSettings", type: "command" }],
      },
      "UserPromptSubmit (flagSettings)",
    ],
    [
      "a managed hook",
      { hooks: [], policy: { ...NO_HOOKS.policy, policyHookCount: 1 } },
      "managed settings define 1 hook",
    ],
    [
      "a policy that hides managed hooks",
      { hooks: [], policy: { ...NO_HOOKS.policy, managedOnly: true } },
      "managed policy hides",
    ],
    [
      "unreadable managed settings",
      { hooks: [], policy: { ...NO_HOOKS.policy, policyUnreadable: true as const } },
      "could not be read",
    ],
    ["a missing policy", { hooks: [] }, "hook policy was not reported"],
  ])("fails on %s, since hooks see the prompt", async (_label, hooks, message) => {
    expect((await surfaceFailure({ hooks })).message).toContain(message);
  });

  test("ignores hooks the policy keeps from running", async () => {
    await expect(
      verifyClaudeToolFreeSurface({
        provider: "claude",
        probe: probe({
          hooks: {
            ...NO_HOOKS,
            hooks: [{ event: "Stop", source: "userSettings", type: "command", disabled: true }],
          },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  test("fails closed when the SDK cannot list hooks", async () => {
    expect((await surfaceFailure({ hooks: "unsupported" })).message).toContain("cannot list hooks");
  });

  test("fails closed on a CLI that cannot report its surface", async () => {
    expect((await surfaceFailure({ failUsage: true })).message).toContain("get_context_usage");
  });
});

interface RecordedQuery {
  options: ClaudeOptions[];
  promptsDelivered: number;
  /** Prompts each process received, by launch order. */
  deliveredTo: number[];
  closed: number[];
}

function emptyRecord(): RecordedQuery {
  return { options: [], promptsDelivered: 0, deliveredTo: [], closed: [] };
}

// A query dependency that answers the control requests like Claude Code and records whether a
// prompt ever reached the process. A function script answers per launch.
function recordingQuery(
  script: SurfaceScript | ((launch: number) => SurfaceScript),
  recorded: RecordedQuery,
): ClaudeQueryFactory {
  return ({ prompt, options }) => {
    const launch = recorded.options.length;
    recorded.options.push(options);
    recorded.deliveredTo.push(0);
    const launchScript = typeof script === "function" ? script(launch) : script;
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    // Like the SDK, read the prompt stream as soon as the process starts, whoever reads its output.
    const results: number[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    void (async () => {
      for await (const _message of prompt) {
        recorded.promptsDelivered += 1;
        recorded.deliveredTo[launch] = (recorded.deliveredTo[launch] ?? 0) + 1;
        results.push(recorded.promptsDelivered);
        wake?.();
      }
      ended = true;
      wake?.();
    })();
    const messages = (async function* () {
      while (true) {
        if (results.length === 0) {
          if (ended) return;
          await new Promise<void>((done) => {
            wake = done;
          });
          wake = null;
          continue;
        }
        const index = results.shift()!;
        yield {
          type: "result",
          subtype: "success",
          session_id: "tool-free-session",
          duration_ms: 1,
          duration_api_ms: 0,
          is_error: false,
          num_turns: 1,
          result: "",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
          uuid: `result-${index}`,
        };
      }
    })();
    return Object.assign(messages, probe(launchScript), launchScript.override ?? {}, {
      close: () => {
        recorded.closed.push(launch);
        void messages.return();
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
    }) as unknown as ReturnType<ClaudeQueryFactory>;
  };
}

async function runToolFreeTurn(
  script: SurfaceScript,
  config: AgentSessionConfig = TOOL_FREE_CONFIG,
) {
  const recorded = emptyRecord();
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: recordingQuery(script, recorded),
    resolveBinary: async () => process.execPath,
  });
  const session = await client.createSession(config);
  try {
    const events = await collectSessionTurnEvents(session, "Translate: canary-7f3a");
    return { events, recorded, session };
  } finally {
    await session.close();
  }
}

describe("Claude tool-free session", () => {
  test("launches with no tool source and sends the prompt after the surface check", async () => {
    const { events, recorded } = await runToolFreeTurn({});
    expect(recorded.promptsDelivered).toBe(1);
    const options = recorded.options[0];
    expect(options?.tools).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.settingSources).toEqual([]);
    expect(options).not.toHaveProperty("mcpServers");
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
  });

  test("never sends the prompt when an MCP server shows up before the turn", async () => {
    const { events, recorded } = await runToolFreeTurn({
      servers: [{ name: "late-plugin", status: "pending" }],
    });
    expect(recorded.promptsDelivered).toBe(0);
    const failed = events.find((event) => event.type === "turn_failed");
    expect(failed).toMatchObject({ error: expect.stringContaining("late-plugin") });
  });

  test("never sends the prompt when built-in tools are present", async () => {
    const usage = cleanSurface();
    usage.categories.push({ id: "system_tools", name: "System tools", tokens: 8_271 });
    const { recorded } = await runToolFreeTurn({ usage });
    expect(recorded.promptsDelivered).toBe(0);
  });

  test("refuses a steer, so every prompt passes the check", async () => {
    const recorded = emptyRecord();
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: recordingQuery({}, recorded),
      resolveBinary: async () => process.execPath,
    });
    const session = await client.createSession(TOOL_FREE_CONFIG);
    try {
      await expect(session.steerActiveTurn?.("more", { expectedTurnId: "any" })).resolves.toEqual({
        status: "unavailable",
      });
    } finally {
      await session.close();
    }
  });

  test("refuses MCP servers and unsafe options before a session exists", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: recordingQuery({}, emptyRecord()),
      resolveBinary: async () => process.execPath,
    });
    await expect(
      client.createSession({
        ...TOOL_FREE_CONFIG,
        mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } },
      }),
    ).rejects.toThrow(ToolFreeAgentError);
    await expect(
      client.createSession({ ...TOOL_FREE_CONFIG, providerOptions: { allowedTools: ["Bash"] } }),
    ).rejects.toThrow(ToolFreeAgentError);
  });

  test("an ordinary agent keeps the full Claude Code launch", async () => {
    const recorded = emptyRecord();
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: recordingQuery({ servers: [{ name: "user", status: "connected" }] }, recorded),
      resolveBinary: async () => process.execPath,
    });
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await collectSessionTurnEvents(session, "hello");
    } finally {
      await session.close();
    }
    expect(recorded.promptsDelivered).toBe(1);
    expect(recorded.options[0]?.tools).toBeUndefined();
    expect(recorded.options[0]?.settingSources).toEqual(["user", "project", "local"]);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise((done) => setTimeout(done, 2));
  }
  expect(condition()).toBe(true);
}

describe("Claude tool-free session, adversarial", () => {
  function toolFreeClient(
    script: SurfaceScript | ((launch: number) => SurfaceScript),
    resolveBinary: () => Promise<string> = async () => process.execPath,
  ) {
    const recorded = emptyRecord();
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: recordingQuery(script, recorded),
      resolveBinary,
    });
    return { client, recorded };
  }

  test("an options patch that would widen the launch is refused before anything changes", async () => {
    const { client, recorded } = toolFreeClient({});
    const session = await client.createSession(TOOL_FREE_CONFIG);
    try {
      for (const patch of [
        { extraArgs: { settings: "/tmp/hooks.json" } },
        { allowedTools: ["Bash"] },
        { settings: { permissions: { allow: ["Bash"] } } },
      ]) {
        await expect(session.applyOptions?.(patch)).rejects.toThrow(ToolFreeAgentError);
      }
      await collectSessionTurnEvents(session, "Translate: canary");
    } finally {
      await session.close();
    }
    const launched = recorded.options[0];
    expect(launched).not.toHaveProperty("extraArgs");
    expect(launched).not.toHaveProperty("allowedTools");
    expect(launched?.settings).toEqual({
      disableClaudeAiConnectors: true,
      disableSkillShellExecution: true,
    });
  });

  test.each(["/rewind", "  /compact", "/init now"])(
    "%s is refused before any command or process runs",
    async (prompt) => {
      const { client, recorded } = toolFreeClient({});
      const session = await client.createSession(TOOL_FREE_CONFIG);
      try {
        await expect(session.startTurn(prompt)).rejects.toThrow(/slash commands/u);
        await expect(session.startTurn([{ type: "text", text: "/rewind" }])).rejects.toThrow(
          /slash commands/u,
        );
      } finally {
        await session.close();
      }
      expect(recorded.options).toHaveLength(0);
    },
  );

  test("a failed check retires the process it ran on", async () => {
    const { client, recorded } = toolFreeClient((launch) =>
      launch === 0 ? { servers: [{ name: "late", status: "pending" }] } : {},
    );
    const session = await client.createSession(TOOL_FREE_CONFIG);
    try {
      const first = await collectSessionTurnEvents(session, "Translate: one");
      expect(first.some((event) => event.type === "turn_failed")).toBe(true);
      expect(recorded.closed).toContain(0);
      // The next turn starts a fresh process and checks it again.
      await collectSessionTurnEvents(session, "Translate: two");
    } finally {
      await session.close();
    }
    expect(recorded.deliveredTo).toEqual([0, 1]);
  });

  test("a process another caller starts during the check is checked before it gets the prompt", async () => {
    const binaryGates = [deferred<string>(), deferred<string>()];
    let binaryCalls = 0;
    const checkHeld = deferred();
    const { client, recorded } = toolFreeClient(
      (launch) =>
        launch === 0
          ? {
              override: {
                initializationResult: async () => {
                  await checkHeld.promise;
                  return { hooks_applied: true, hook_on_failure_supported: true };
                },
              },
            }
          : { servers: [{ name: "late-plugin", status: "pending" }] },
      () => binaryGates[binaryCalls++]!.promise,
    );
    const session = await client.createSession(TOOL_FREE_CONFIG);
    try {
      const events: string[] = [];
      session.subscribe((event) => {
        if (event.type === "turn_failed") events.push(event.error);
      });
      const turn = session.startTurn("Translate: canary-race");
      await until(() => binaryCalls === 1);
      const listing = session.listCommands?.();
      await until(() => binaryCalls === 2);
      binaryGates[0]!.resolve(process.execPath);
      await until(() => recorded.options.length === 1);
      binaryGates[1]!.resolve(process.execPath);
      await until(() => recorded.options.length === 2);
      checkHeld.resolve();
      await turn;
      await listing?.catch(() => undefined);
      await until(() => events.length > 0);
      expect(events[0]).toContain("late-plugin");
    } finally {
      await session.close();
    }
    expect(recorded.deliveredTo).toEqual([0, 0]);
  });
});

describe("Claude tool-free review regressions", () => {
  function toolFreeClient(
    script: SurfaceScript | ((launch: number) => SurfaceScript),
    resolveBinary: () => Promise<string> = async () => process.execPath,
  ) {
    const recorded = emptyRecord();
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: recordingQuery(script, recorded),
      resolveBinary,
    });
    return { client, recorded };
  }

  async function settle(microtasks: number): Promise<void> {
    for (let index = 0; index < microtasks; index += 1) await Promise.resolve();
  }

  // Process 0 passes the check and, `offset` microtasks after its last answer, lets process 1
  // finish launching. Process 1 has an MCP server, so it must never get the prompt.
  function replacedAfter(offset: number, release: () => void) {
    async function releaseLater(): Promise<void> {
      await settle(offset);
      release();
    }
    return (launch: number): SurfaceScript =>
      launch === 0
        ? {
            override: {
              getHooksListing: async () => {
                void releaseLater();
                return NO_HOOKS;
              },
            },
          }
        : { servers: [{ name: "unchecked", status: "pending" }] };
  }

  // The replacing process starts at every microtask offset after the checked process answers its
  // last control request, so one run lands between the check returning and the prompt going out.
  test("a process that replaces the checked one at any later moment never gets the prompt", async () => {
    let replacedBeforeSend = 0;
    let sentToChecked = 0;
    for (let offset = 0; offset <= 40; offset += 1) {
      const firstBinary = deferred<string>();
      const secondBinary = deferred<string>();
      let binaryCalls = 0;
      const { client, recorded } = toolFreeClient(
        replacedAfter(offset, () => secondBinary.resolve(process.execPath)),
        () => (binaryCalls++ === 0 ? firstBinary.promise : secondBinary.promise),
      );
      const session = await client.createSession(TOOL_FREE_CONFIG);
      try {
        let failed = false;
        session.subscribe((event) => {
          if (event.type === "turn_failed") failed = true;
        });
        // The turn launches process 0; a command listing started at the same time launches
        // process 1, which replaces it at a moment set by `offset`.
        const starting = session.startTurn(`Translate: canary-${offset}`);
        await until(() => binaryCalls === 1);
        const listing = session.listCommands?.().catch(() => undefined);
        await until(() => binaryCalls === 2);
        firstBinary.resolve(process.execPath);
        await starting;
        await listing;
        await until(() => failed || recorded.promptsDelivered > 0);
        expect(recorded.options).toHaveLength(2);
        expect({ offset, unchecked: recorded.deliveredTo[1] ?? 0 }).toEqual({
          offset,
          unchecked: 0,
        });
        if ((recorded.deliveredTo[0] ?? 0) > 0) sentToChecked += 1;
        else replacedBeforeSend += 1;
      } finally {
        await session.close();
      }
    }
    // The sweep covers both sides of the send, or it proved nothing.
    expect(replacedBeforeSend).toBeGreaterThan(0);
    expect(sentToChecked).toBeGreaterThan(0);
  });

  test.each([
    ["policyHookCount", { managedOnly: false, pluginOnly: false }],
    ["managedOnly", { pluginOnly: false, policyHookCount: 0 }],
    ["pluginOnly", { managedOnly: false, policyHookCount: 0 }],
  ])(
    "a hook policy without %s is not taken as safe, and nothing is sent",
    async (_field, policy) => {
      const hooks = { hooks: [], policy } as ClaudeHooksListing;
      expect((await surfaceFailure({ hooks })).reason).toBe("surface_unverified");
      const { client, recorded } = toolFreeClient({ hooks });
      const session = await client.createSession(TOOL_FREE_CONFIG);
      try {
        const events = await collectSessionTurnEvents(session, "Translate: canary-policy");
        expect(events.some((event) => event.type === "turn_failed")).toBe(true);
      } finally {
        await session.close();
      }
      expect(recorded.promptsDelivered).toBe(0);
    },
  );

  const history = (text: string) => ({
    type: "text" as const,
    mimeType: "text/plain" as const,
    contextKind: "chat_history",
    text,
  });

  test("earlier chat history with a typed slash command is refused, as Claude Code would run it", async () => {
    const { client, recorded } = toolFreeClient({});
    const session = await client.createSession(TOOL_FREE_CONFIG);
    try {
      const prompt = buildAgentPrompt("/compact", undefined, [history("Earlier: hello")]);
      await expect(session.startTurn(prompt)).rejects.toThrow(/slash commands/u);
    } finally {
      await session.close();
    }
    expect(recorded.options).toHaveLength(0);
  });

  test("a slash command inside earlier chat history does not block plain text", async () => {
    const { client, recorded } = toolFreeClient({});
    const session = await client.createSession(TOOL_FREE_CONFIG);
    try {
      const prompt = buildAgentPrompt("Translate: canary-history", undefined, [
        history("/rewind 3"),
      ]);
      await collectSessionTurnEvents(session, prompt);
    } finally {
      await session.close();
    }
    expect(recorded.promptsDelivered).toBe(1);
  });

  test("an attachment that would be sent last and reads as a command is refused", async () => {
    const { client, recorded } = toolFreeClient({});
    const session = await client.createSession(TOOL_FREE_CONFIG);
    try {
      const prompt = buildAgentPrompt("Translate this file", undefined, [
        { type: "text", mimeType: "text/plain", text: "/init" },
      ]);
      await expect(session.startTurn(prompt)).rejects.toThrow(/slash commands/u);
    } finally {
      await session.close();
    }
    expect(recorded.options).toHaveLength(0);
  });
});
