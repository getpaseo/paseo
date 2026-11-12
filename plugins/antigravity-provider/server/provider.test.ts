import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderContent,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import contribute from "../index.server.js";
import { signalPlan } from "./internal/signals.js";
import { Usage, parseResetTimestamp } from "./internal/usage.js";

const temporary: string[] = [];
const connections: ProviderConnection[] = [];
const fake = fileURLToPath(new URL("../test/agy.mjs", import.meta.url));

function registerPlugin(): {
  provider: ProviderRegistration;
  usageSource: UsageSourceRegistration;
} {
  let provider: ProviderRegistration | undefined;
  let usageSource: UsageSourceRegistration | undefined;
  const dispose = contribute({
    registerProvider(registration) {
      provider = registration;
    },
    registerUsageSource(source) {
      usageSource = source;
    },
  });
  expect(typeof dispose).toBe("function");
  if (!provider || !usageSource) {
    throw new Error("Expected contribute() to register both provider and usage source");
  }
  return { provider, usageSource };
}

it("publishes a monochrome, theme-aware provider icon", async () => {
  const icon = await readFile(new URL("../icon.svg", import.meta.url), "utf8");
  expect(icon).toContain('viewBox="0 0 24 24"');
  expect(icon).toContain('fill="currentColor"');
  expect(icon).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|url\(/i);
  expect(icon).not.toMatch(/<(?:style|mask|defs|linearGradient|radialGradient)\b|\bid=/i);
  expect([...icon.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)].map((match) => match[1])).toEqual([
    "currentColor",
  ]);
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness(env: Record<string, string> = {}) {
  const { provider, usageSource } = registerPlugin();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
  temporary.push(cwd);
  const log = path.join(cwd, "argv.ndjson");
  const launch: ProviderLaunch = {
    command: process.execPath,
    args: [fake, "--launch-prefix"],
    env: { AGY_TEST_LOG: log, HOME: cwd, ...env },
  };
  const connection = await provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch,
  });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });
  async function wait(predicate: (event: ProviderEvent) => boolean) {
    await expect.poll(() => events.some(predicate), { timeout: 5000, interval: 10 }).toBe(true);
    const event = events.find(predicate);
    if (!event) throw new Error("Expected event missing");
    return event;
  }
  async function request(input: ProviderInput) {
    await connection.send(input);
    if ("requestId" in input) {
      await wait(
        (event) =>
          "requestId" in event &&
          event.requestId === input.requestId &&
          (event.type === "request.completed" ||
            event.type === "request.failed" ||
            event.type === "session.ready" ||
            event.type === "catalog" ||
            event.type === "sessions" ||
            event.type === "session.can_stop_runtime"),
      );
    }
  }
  async function open(
    options: {
      restored?: ProviderPersistence;
      sessionId?: string;
      history?: "replay" | "skip";
      config?: Partial<ProviderSessionConfig>;
    } = {},
  ) {
    const sessionId = options.sessionId ?? "s";
    await request({
      type: "session.open",
      requestId: `open-${events.length}`,
      sessionId,
      persistence: options.restored,
      history: options.history ?? "replay",
      config: {
        cwd,
        env: { AGY_SESSION_VALUE: "session-overlay" },
        settings: {},
        mcpServers: {
          "test-mcp": {
            type: "stdio",
            command: "node",
            args: ["mcp.js"],
          },
          "remote-mcp": {
            type: "http",
            url: "https://mcp.example.test/api",
            headers: { Authorization: "Bearer test" },
          },
        },
        persist: true,
        systemPrompt: "SYSTEM PREFIX",
        ...options.config,
      },
    });
  }
  async function message(content: ProviderContent[], sessionId = "s") {
    const clientMessageId = `prompt-${events.length}`;
    await connection.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "message", content },
      },
    });
    await wait(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    return clientMessageId;
  }
  function prompt(text: string, sessionId = "s") {
    return message([{ type: "text", text }], sessionId);
  }
  async function completed(clientMessageId: string) {
    const result = events.find(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    if (!result || result.type !== "session.prompt_result" || result.result.type !== "turn") {
      throw new Error("Prompt was not admitted");
    }
    const turnId = result.result.turnId;
    return wait(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
  }
  async function records() {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  function persistence() {
    const opened = events.find((event) => event.type === "session.opened");
    if (!opened || opened.type !== "session.opened" || !opened.persistence) {
      throw new Error("Missing persistence");
    }
    return opened.persistence;
  }
  return {
    provider,
    usageSource,
    connection,
    events,
    launch,
    cwd,
    wait,
    request,
    open,
    prompt,
    message,
    completed,
    records,
    persistence,
  };
}

it("streams ACP text snapshots, forwards systemPrompt and MCP servers, and publishes slash commands", async () => {
  const h = await harness();
  expect(h.connection.capabilities).toEqual([
    "prompt.message",
    "prompt.command",
    "prompt.image",
    "session.can_stop_runtime",
    "session.configure",
    "session.list",
    "session.persistence",
    "permission",
    "permission.tool_policy",
  ]);
  await h.open();

  await h.wait(
    (event) =>
      event.type === "session.commands" && event.commands.some((cmd) => cmd.name === "plan"),
  );

  await h.completed(await h.prompt("HELLO"));
  await h.completed(await h.prompt("HELLO AGAIN"));

  const cmdId = "cmd-1";
  await h.connection.send({
    type: "session.prompt",
    sessionId: "s",
    prompt: {
      clientMessageId: cmdId,
      delivery: "auto",
      input: { type: "command", name: "plan", arguments: "ship it" },
    },
  });
  await h.wait(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === cmdId,
  );
  await h.completed(cmdId);

  const text = h.events.filter(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  expect(
    text.map((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message"
        ? event.item.text
        : "",
    ),
  ).toEqual([
    "PHASE0_HELLO",
    "PHASE0_HELLO\n",
    "PHASE0_HELLO",
    "PHASE0_HELLO\n",
    "PHASE0_HELLO",
    "PHASE0_HELLO\n",
  ]);

  const records = await h.records();
  const acpLaunch = records.find((entry) => entry.args?.includes("acp"));
  expect(acpLaunch.args).toEqual(["--launch-prefix", "acp", "--stdio", "--add-dir", h.cwd]);
  expect(acpLaunch.env).toBe("session-overlay");
  expect(acpLaunch.noColor).toBe("1");

  const sessionNew = records.find((entry) => entry.rpc?.method === "session/new")?.rpc;
  expect(sessionNew.params).toMatchObject({
    cwd: h.cwd,
    mcpServers: [
      { name: "test-mcp", command: "node", args: ["mcp.js"], env: [] },
      {
        type: "http",
        name: "remote-mcp",
        url: "https://mcp.example.test/api",
        headers: [{ name: "Authorization", value: "Bearer test" }],
      },
    ],
    _meta: {
      antigravity: {
        systemPrompt: { append: "SYSTEM PREFIX" },
      },
    },
  });

  expect(
    records.filter((entry) => entry.input).map((entry) => entry.input.message.content),
  ).toEqual(["HELLO", "HELLO AGAIN", "/plan ship it"]);
});

it("enforces default, accept-edits, and full-access permission modes and mid-turn mode escalation", async () => {
  const h = await harness();
  await h.open();
  expect(h.events.some((event) => event.type === "session.notice")).toBe(false);

  // 1. Default mode asks before shell execution and reports canStopRuntime=false while waiting.
  const turn1 = await h.prompt("TOOLS");
  const shellPerm = await h.wait(
    (event) => event.type === "session.permission" && event.request.kind === "tool",
  );
  if (shellPerm.type !== "session.permission") throw new Error("Expected permission event");
  expect(shellPerm.request).toMatchObject({
    name: "run_command",
    kind: "tool",
    detail: { type: "shell", command: "printf PHASE0_SHELL" },
  });

  await h.request({
    type: "session.can_stop_runtime",
    requestId: "can-stop-busy",
    sessionId: "s",
  });
  expect(
    h.events.find(
      (event) => event.type === "session.can_stop_runtime" && event.requestId === "can-stop-busy",
    ),
  ).toMatchObject({ canStop: false });

  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: shellPerm.request.id,
    response: { behavior: "allow" },
  });
  await h.completed(turn1);

  await h.request({
    type: "session.can_stop_runtime",
    requestId: "can-stop-idle",
    sessionId: "s",
  });
  expect(
    h.events.find(
      (event) => event.type === "session.can_stop_runtime" && event.requestId === "can-stop-idle",
    ),
  ).toMatchObject({ canStop: true });

  // 2. Accept-edits auto-approves native file edits while still asking before shell commands.
  await h.request({
    type: "session.configure",
    requestId: "set-accept-edits",
    sessionId: "s",
    changes: { mode: "accept-edits" },
  });
  const permsBeforeTurn2 = h.events.filter((event) => event.type === "session.permission").length;
  const turn2 = await h.prompt("EDIT_AND_SHELL");
  await expect
    .poll(
      () =>
        h.events.slice(permsBeforeTurn2 ? 0 : 0).filter((e) => e.type === "session.permission")
          .length,
      { timeout: 5000, interval: 10 },
    )
    .toBe(permsBeforeTurn2 + 1);
  const turn2Perms = h.events
    .filter((event) => event.type === "session.permission")
    .slice(permsBeforeTurn2);
  expect(turn2Perms).toHaveLength(1);
  const npmTestPerm = turn2Perms[0]!;
  if (npmTestPerm.type !== "session.permission") throw new Error("Expected permission");
  expect(npmTestPerm.request).toMatchObject({
    detail: { type: "shell", command: "npm test" },
  });

  // Escalating to full-access mid-turn auto-approves the pending shell permission.
  await h.request({
    type: "session.configure",
    requestId: "set-full-access",
    sessionId: "s",
    changes: { mode: "full-access" },
  });
  await h.completed(turn2);
  expect(h.events).toContainEqual({
    type: "session.permission_resolved",
    sessionId: "s",
    permissionId: npmTestPerm.request.id,
  });

  // 3. Full-access mode auto-approves subsequent tool calls without asking.
  const permsBeforeTurn3 = h.events.filter((event) => event.type === "session.permission").length;
  await h.completed(await h.prompt("EDIT_AND_SHELL"));
  expect(h.events.filter((event) => event.type === "session.permission")).toHaveLength(
    permsBeforeTurn3,
  );
});

it("never auto-approves external MCP tools with query arguments in accept-edits unless preapproved in toolPolicy", async () => {
  const h = await harness();
  await h.open({
    config: {
      mode: "accept-edits",
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "docs", tool: "lookup" }],
      },
    },
  });

  const turn = await h.prompt("MCP_SECURITY_CHECK");
  const perm = await h.wait(
    (event) => event.type === "session.permission" && event.request.name === "mcp__db__execute",
  );
  if (perm.type !== "session.permission") throw new Error("Expected MCP permission prompt");

  // Even though UI detail renders `{ query }` as a search card, accept-edits MUST NOT auto-approve it.
  expect(perm.request.detail).toMatchObject({ type: "search", query: "DELETE FROM users" });
  expect(
    h.events.filter(
      (event) => event.type === "session.permission" && event.request.name === "mcp__docs__lookup",
    ),
  ).toHaveLength(0);

  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: perm.request.id,
    response: { behavior: "deny" },
  });

  const perm2 = await h.wait(
    (event) =>
      event.type === "session.permission" && event.request.name === "mcp__other__destructive",
  );
  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: perm2.request.id,
    response: { behavior: "deny" },
  });

  const perm3 = await h.wait(
    (event) => event.type === "session.permission" && event.request.name === "run_command",
  );
  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: perm3.request.id,
    response: { behavior: "deny" },
  });
  await h.completed(turn);

  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        type: "assistant_message",
        text: "MCP_RESULT:preapproved=true,danger=false,spoofed=false,wrapper=true,titleSpoofed=false\n",
      }),
    }),
  );
});

it("handles elicitation/create ask_question cards for single-select, multi-select, and free-form Other answers", async () => {
  const h = await harness();
  await h.open();

  const turn = await h.prompt("ASK_QUESTION");
  const questionPerm = await h.wait(
    (event) => event.type === "session.permission" && event.request.kind === "question",
  );
  if (questionPerm.type !== "session.permission") throw new Error("Expected question permission");

  expect(questionPerm.request).toMatchObject({
    name: "ask_question",
    kind: "question",
    input: {
      questions: [
        {
          id: "q0",
          question: "Which UI library should we use?",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false,
          allowOther: true,
          allowEmpty: false,
        },
        {
          id: "q1",
          header: "Targets",
          question: "Select target platforms",
          options: [{ label: "Web" }, { label: "Desktop" }, { label: "Mobile" }],
          multiSelect: true,
          allowOther: true,
          allowEmpty: true,
        },
      ],
    },
  });

  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: questionPerm.request.id,
    response: {
      behavior: "allow",
      updatedInput: {
        answers: {
          q0: "Svelte",
          Targets: ["Web", "CLI"],
        },
      },
    },
  });
  await h.completed(turn);

  const assistant = h.events.findLast(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  expect(assistant).toMatchObject({
    type: "timeline.item",
    item: {
      type: "assistant_message",
      text: 'QUESTION_RESULT:{"action":"accept","content":{"q0":"Other","q0_other":"Svelte","q1_other":"CLI","q1":["Web","Other"]}}\n',
    },
  });
});

it("switches models transactionally over ACP and resets to the default model on model: null", async () => {
  const h = await harness({ AGY_TEST_FAIL_SET_MODEL_ONCE: "yes" });
  await h.open();

  // First attempt fails on the wire: Session must NOT mutate its model state.
  await h.request({
    type: "session.configure",
    requestId: "set-model-fail",
    sessionId: "s",
    changes: { model: "gemini-3.8-flash-low" },
  });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "request.failed",
      requestId: "set-model-fail",
      error: expect.objectContaining({
        message: expect.stringContaining("Transient model switch"),
      }),
    }),
  );

  // Retrying with the exact same target model must still invoke session/set_model and succeed.
  await h.request({
    type: "session.configure",
    requestId: "set-model-retry",
    sessionId: "s",
    changes: { model: "gemini-3.8-flash-low" },
  });
  expect(h.events.findLast((event) => event.type === "session.config")).toMatchObject({
    config: { model: "gemini-3.8-flash-low" },
  });

  // Clearing the override (`model: null`) resets ACP back to the session's initial default model.
  await h.request({
    type: "session.configure",
    requestId: "reset-model",
    sessionId: "s",
    changes: { model: null },
  });
  expect(h.events.findLast((event) => event.type === "session.config")).toMatchObject({
    config: { model: "gemini-4-argon-medium" },
  });

  const setModelCalls = (await h.records())
    .filter((entry) => entry.rpc?.method === "session/set_model")
    .map((entry) => entry.rpc.params.modelId);
  expect(setModelCalls).toEqual([
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-low",
    "gemini-4-argon-medium",
  ]);
  expect((await h.records()).filter((entry) => entry.args?.includes("acp"))).toHaveLength(1);
});

it("lists native ACP sessions with pagination, symlinked cwd/query filtering, and replays or skips history on load", async () => {
  const h = await harness();
  const realCwd = await realpath(h.cwd);
  let queryCwd = h.cwd;
  if (process.platform !== "win32") {
    const linkParent = await mkdtemp(path.join(os.tmpdir(), "agy-symlink-"));
    temporary.push(linkParent);
    queryCwd = path.join(linkParent, "workspace-link");
    await symlink(realCwd, queryCwd, "dir");
  }
  await h.request({
    type: "sessions",
    requestId: "list-filtered",
    cwd: queryCwd,
    query: "quota",
    limit: 5,
  });
  const listEvent = h.events.find(
    (event) => event.type === "sessions" && event.requestId === "list-filtered",
  );
  expect(listEvent).toEqual({
    type: "sessions",
    requestId: "list-filtered",
    sessions: [
      {
        cwd: realCwd,
        title: "Add usage quota reporting",
        updatedAt: "2026-11-03T16:30:00.000Z",
        persistence: {
          version: 1,
          data: { conversationId: "conv-beta-2" },
        },
      },
    ],
  });

  // Open with history: "replay" emits replayed user/assistant/todo items AFTER session.opened and BEFORE session.ready.
  await h.open({
    sessionId: "replayed",
    history: "replay",
    restored: { version: 1, data: { conversationId: "conv-beta-2" } },
  });
  const replayedEvents = h.events.filter(
    (event) => "sessionId" in event && event.sessionId === "replayed",
  );
  const openedIdx = replayedEvents.findIndex((event) => event.type === "session.opened");
  const readyIdx = replayedEvents.findIndex((event) => event.type === "session.ready");
  const timelineIdx = replayedEvents
    .map((event, index) => (event.type === "timeline.item" ? index : -1))
    .filter((index) => index >= 0);
  expect(timelineIdx.length).toBe(3);
  expect(timelineIdx.every((idx) => idx > openedIdx && idx < readyIdx)).toBe(true);
  expect(
    replayedEvents
      .filter((event) => event.type === "timeline.item")
      .map((event) => (event.type === "timeline.item" ? event.item : null)),
  ).toEqual([
    { type: "user_message", id: "user_message_chunk:replay-u1", text: "REPLAYED_USER" },
    { type: "assistant_message", id: "agent_message_chunk:replay-a1", text: "REPLAYED_ASSISTANT" },
    {
      type: "todo",
      id: expect.any(String),
      items: [
        {
          id: expect.any(String),
          text: "Inspect plugin SDK",
          completed: true,
          status: "completed",
        },
        {
          id: expect.any(String),
          text: "Ship ACP provider",
          completed: false,
          status: "in_progress",
        },
      ],
    },
  ]);

  // Open with history: "skip" suppresses replay items on reconnect.
  await h.open({
    sessionId: "skipped",
    history: "skip",
    restored: { version: 1, data: { conversationId: "conv-beta-2" } },
  });
  expect(
    h.events.filter((event) => event.type === "timeline.item" && event.sessionId === "skipped"),
  ).toEqual([]);
});

it("preserves context window occupancy and estimated session cost across usage_update and turn completion", async () => {
  const h = await harness();
  await h.open();
  await h.completed(await h.prompt("MULTI"));
  await h.completed(await h.prompt("MULTI"));

  const finalUsage = h.events.findLast((event) => event.type === "session.usage");
  expect(finalUsage).toMatchObject({
    type: "session.usage",
    usage: {
      inputTokens: 11604,
      outputTokens: 120,
      contextWindowMaxTokens: 1_048_576,
      contextWindowUsedTokens: 11724,
      totalCostUsd: expect.any(Number),
    },
  });
  if (!finalUsage || finalUsage.type !== "session.usage") throw new Error("Missing usage");
  expect(finalUsage.usage.totalCostUsd).toBeGreaterThan(0);

  const persistence = h.persistence();
  await h.request({ type: "session.close", sessionId: "s", requestId: "close" });
  await h.open({ restored: persistence, history: "skip" });
  await h.completed(await h.prompt("RESUME"));
  expect(h.events.findLast((event) => event.type === "session.usage")).toMatchObject({
    usage: {
      inputTokens: 11815,
      outputTokens: 120,
      contextWindowMaxTokens: 1_048_576,
      contextWindowUsedTokens: 11935,
    },
  });
});

it("maps subagent tool calls with childSessionId and recovers from transient stderr retry logs", async () => {
  const h = await harness();
  await h.open();
  await h.completed(await h.prompt("SUBAGENT"));
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        name: "invoke_subagent",
        status: "completed",
        detail: expect.objectContaining({
          type: "sub_agent",
          childSessionId: "b6f02329-7415-49a7-a9a9-1cd09e898d26",
        }),
      }),
    }),
  );

  await h.completed(await h.prompt("TRANSIENT_RETRY"));
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        type: "assistant_message",
        text: "RECOVERED_AFTER_RETRY\n",
      }),
    }),
  );
});

it.each(["HANG", "TOOL_HANG"])(
  "interrupts %s via session/cancel without killing the ACP process",
  async (text) => {
    const h = await harness();
    await h.open();
    const message = await h.prompt(text);
    await h.wait(
      (event) =>
        event.type === "timeline.item" &&
        (event.item.type === "assistant_message" || event.item.type === "tool_call"),
    );
    await h.request({ type: "session.interrupt", requestId: "interrupt", sessionId: "s" });
    expect(await h.completed(message)).toMatchObject({ state: "canceled" });
    await h.completed(await h.prompt("HELLO"));

    const records = await h.records();
    expect(records.filter((entry) => entry.args?.includes("acp"))).toHaveLength(1);
    expect(records.some((entry) => entry.rpc?.method === "session/cancel")).toBe(true);
  },
);

it("escalates to signals and respawns via session/load when session/cancel is ignored", async () => {
  const h = await harness({ AGY_TEST_IGNORE_CANCEL: "yes", AGY_TEST_IGNORE_SIGNALS: "yes" });
  await h.open();
  const message = await h.prompt("HANG");
  await h.wait(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  await h.request({ type: "session.interrupt", requestId: "interrupt-timeout", sessionId: "s" });
  expect(await h.completed(message)).toMatchObject({ state: "canceled" });
  expect((await h.records()).filter((entry) => entry.signal)).toEqual(
    process.platform === "win32" ? [] : [{ signal: "SIGINT" }, { signal: "SIGTERM" }],
  );
  await h.completed(await h.prompt("HELLO"));
  expect((await h.records()).some((entry) => entry.rpc?.method === "session/load")).toBe(true);
});

it.runIf(process.platform !== "win32")(
  "reaps surviving child processes in the ACP POSIX process group on session.close",
  async () => {
    const h = await harness();
    await h.open();
    await h.completed(await h.prompt("SPAWN_ORPHAN"));
    const orphanRecord = (await h.records()).find((entry) => typeof entry.orphanPid === "number");
    const orphanPid: number = orphanRecord.orphanPid;
    expect(() => process.kill(orphanPid, 0)).not.toThrow();

    await h.request({ type: "session.close", requestId: "close-orphan", sessionId: "s" });

    await expect
      .poll(() => {
        try {
          process.kill(orphanPid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  },
);

it.each(["auth", "exit", "stderr"])(
  "reports startup %s without waiting for init forever",
  async (startup) => {
    const h = await harness({ AGY_TEST_STARTUP: startup });
    await h.open();
    expect(h.events.filter((event) => event.type === "session.ready")).toEqual([]);
    const failure = h.events.find((event) => event.type === "request.failed");
    expect(failure).toMatchObject({
      type: "request.failed",
      error: {
        message: expect.stringMatching(startup === "exit" ? /exited/ : /Run `agy` and sign in/),
      },
    });
  },
);

it("rejects mid-turn steering and overlapping turns cleanly", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("HANG");
  const second = await h.prompt("SECOND");
  expect(
    h.events.find(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === second,
    ),
  ).toMatchObject({
    type: "session.prompt_result",
    result: { type: "failed", error: { code: "TURN_ACTIVE" } },
  });
  await expect(
    h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "x" }] },
      },
    }),
  ).rejects.toThrow(/prompt.steer/);
});

describe("discovery & usage", () => {
  it("parses catalog models with contextWindowMaxTokens and three permission modes", async () => {
    const h = await harness();
    await h.request({ type: "catalog", requestId: "catalog" });
    const event = h.events[0];
    expect(event).toMatchObject({
      type: "catalog",
      catalog: {
        models: expect.arrayContaining([
          {
            id: "gemini-3.8-flash-low",
            label: "Gemini 3.8 Flash (Low)",
            contextWindowMaxTokens: 1_048_576,
          },
        ]),
        thinkingOptions: [],
        defaultMode: "default",
      },
    });
    if (!event || event.type !== "catalog") throw new Error("Missing catalog");
    expect(event.catalog.models).toHaveLength(11);
    expect(event.catalog.modes.map((mode) => mode.id)).toEqual([
      "default",
      "accept-edits",
      "full-access",
    ]);
  });

  it("reports missing, old, unauthenticated and available launches", async () => {
    const { provider } = registerPlugin();
    expect(await provider.status?.({})).toMatchObject({
      available: false,
      diagnostic: expect.stringContaining("agy not found"),
    });
    const missing = await harness();
    expect(
      await provider.status?.({
        launch: { ...missing.launch, command: path.join(missing.cwd, "missing-agy") },
      }),
    ).toMatchObject({ available: false, diagnostic: expect.stringContaining("ENOENT") });
    const old = await harness({ AGY_TEST_VERSION: "1.2.13" });
    expect(await provider.status?.({ launch: old.launch })).toMatchObject({
      available: false,
      diagnostic: expect.stringContaining("1.4.0"),
    });
    const noAcp = await harness({ AGY_TEST_NO_ACP: "yes" });
    expect(await provider.status?.({ launch: noAcp.launch })).toMatchObject({
      available: false,
      diagnostic: expect.stringContaining("agy acp --stdio"),
    });
    const unauthenticated = await harness({ AGY_TEST_AUTH: "missing" });
    expect(await provider.status?.({ launch: unauthenticated.launch })).toEqual({
      available: false,
      diagnostic: "Antigravity authentication failed. Run `agy` and sign in, then retry.",
    });
    const authenticated = await harness();
    expect(await provider.status?.({ launch: authenticated.launch })).toEqual({ available: true });
  });

  it("discovers remembered accounts, isolates non-antigravity sessions, and reports quotas, credits, and plan tier", async () => {
    expect(await new Usage().registration().discover({ kind: "global" })).toEqual([]);

    const h = await harness();
    await h.open();

    // Non-antigravity session scope never matches Antigravity accounts.
    expect(
      await h.usageSource.discover({
        kind: "session",
        provider: "claude",
        env: { HOME: h.cwd },
      }),
    ).toEqual([]);

    const sessionAccounts = await h.usageSource.discover({
      kind: "session",
      provider: "antigravity",
      env: { HOME: h.cwd },
    });
    expect(sessionAccounts).toHaveLength(1);
    const globalAccounts = await h.usageSource.discover({ kind: "global" });
    expect(globalAccounts).toEqual(sessionAccounts);

    const account = globalAccounts[0]!;
    expect(account.key).toMatch(/^[a-f0-9]{64}$/);

    const report = await h.usageSource.fetch(account.input);
    expect(report).toEqual({
      status: "available",
      planLabel: "Google AI Pro",
      windows: [
        {
          id: "gemini:five_hour",
          label: "Gemini · 5-hour",
          shortLabel: "Gemini 5h",
          summary: true,
          usedPct: 18,
          remainingPct: 82,
          resetsAt: "2026-11-04T04:00:00.000Z",
          tone: "ok",
        },
        {
          id: "gemini:weekly",
          label: "Gemini · Weekly",
          shortLabel: "Gemini wk",
          summary: true,
          usedPct: 35,
          remainingPct: 65,
          resetsAt: "2026-11-10T23:28:00.000Z",
          tone: "ok",
        },
        {
          id: "gemini_4_argon:weekly",
          label: "Gemini 4 Argon · Weekly",
          shortLabel: "Gemini 4 Argon wk",
          usedPct: 10,
          remainingPct: 90,
          resetsAt: "2026-11-10T23:28:00.000Z",
          tone: "ok",
        },
        {
          id: "claude_gpt:five_hour",
          label: "Claude & GPT · 5-hour",
          shortLabel: "Claude & GPT 5h",
          usedPct: 80,
          remainingPct: 20,
          resetsAt: "2026-11-04T04:00:00.000Z",
          tone: "warning",
        },
        {
          id: "claude_gpt:weekly",
          label: "Claude & GPT · Weekly",
          shortLabel: "Claude & GPT wk",
          usedPct: 50,
          remainingPct: 50,
          resetsAt: "2026-11-10T23:28:00.000Z",
          tone: "ok",
        },
      ],
      balances: [
        {
          id: "credits",
          label: "Model credits",
          remaining: 42.5,
          unit: "credits",
          tone: "ok",
        },
      ],
    });
  });

  it("maps unauthenticated or empty usage probes to structured unavailable reports", async () => {
    const unauth = await harness({ AGY_TEST_USAGE_AUTH: "missing" });
    const [unauthAccount] = await unauth.usageSource.discover({ kind: "global" });
    expect(await unauth.usageSource.fetch(unauthAccount!.input)).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "agy" },
    });

    const empty = await harness({ AGY_TEST_USAGE_EMPTY: "yes", AGY_TEST_CREDITS_EMPTY: "yes" });
    const [emptyAccount] = await empty.usageSource.discover({ kind: "global" });
    expect(await empty.usageSource.fetch(emptyAccount!.input)).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "No Antigravity usage quota reported" },
    });

    expect(parseResetTimestamp("2026-11-10 20:28 -03")).toBe("2026-11-10T23:28:00.000Z");
    expect(parseResetTimestamp("2026-11-10 20:28 UTC")).toBe("2026-11-10T20:28:00.000Z");
  });
});

describe("process signal plans", () => {
  it.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)("kills the Windows tree for %s", (signal) => {
    expect(signalPlan({ platform: "win32", pid: 123, signal })).toEqual({
      type: "tree",
      command: "taskkill",
      args: ["/PID", "123", "/T", "/F"],
    });
  });
  it.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)(
    "preserves POSIX group signal %s",
    (signal) => {
      expect(signalPlan({ platform: "linux", pid: 123, signal })).toEqual({
        type: "group",
        pid: -123,
        signal,
      });
    },
  );
});

describe("image and rich attachment prompts", () => {
  it.each(["session", "connection"])(
    "reloads ACP with --add-dir for private session images, auto-approves image reads in default mode, and cleans up on %s close",
    async (close) => {
      const h = await harness();
      await h.open();
      const png = await readFile(
        new URL("../test/fixtures/image-file-external.png", import.meta.url),
      );
      const jpeg = Buffer.from("image file bytes");
      await h.completed(
        await h.message([
          { type: "text", text: "Describe these images." },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 42,
            title: "Add ACP transport",
            url: "https://github.com/getpaseo/paseo/pull/42",
            baseRefName: "main",
            headRefName: "feat/acp",
          },
          { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
        ]),
      );

      expect(h.events.filter((event) => event.type === "session.permission")).toEqual([]);
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({
            type: "assistant_message",
            text: "IMAGE_READ_OK\n",
          }),
        }),
      );

      const records = await h.records();
      const sent = records.find((entry) => entry.input).input.message.content;
      const lines = sent.split("\n");
      const pngPath = lines[1].slice("Attached image: ".length);
      const jpegPath = lines[4].slice("Attached image: ".length);
      expect(path.isAbsolute(pngPath)).toBe(true);
      expect(path.extname(pngPath)).toBe(".png");
      expect(path.extname(jpegPath)).toBe(".jpg");
      expect(path.dirname(pngPath)).toBe(path.dirname(jpegPath));
      expect(sent).toContain("Pull Request #42: Add ACP transport (feat/acp -> main)");

      const acpLaunches = records.filter((entry) => entry.args?.includes("acp"));
      expect(acpLaunches.at(-1)?.args).toContain(path.dirname(pngPath));

      if (process.platform !== "win32") {
        expect((await stat(path.dirname(pngPath))).mode & 0o777).toBe(0o700);
        expect((await stat(pngPath)).mode & 0o777).toBe(0o600);
        expect((await stat(jpegPath)).mode & 0o777).toBe(0o600);
      }

      if (close === "connection") await h.connection.close();
      else await h.request({ type: "session.close", requestId: "close-images", sessionId: "s" });
      await expect(stat(path.dirname(pngPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a non-image MIME type before sending an ACP prompt", async () => {
    const h = await harness();
    await h.open();
    const id = await h.message([{ type: "image", data: "dGV4dA==", mimeType: "text/plain" }]);
    expect(
      h.events.find(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === id,
      ),
    ).toMatchObject({
      result: { type: "failed", error: { message: expect.stringContaining("image MIME type") } },
    });
    expect((await h.records()).filter((entry) => entry.input)).toHaveLength(0);
  });
});

describe("lifecycle, cancellation, and recovery edge cases", () => {
  it("does not leak an ACP process when connection closes during initial catalog lookup", async () => {
    const h = await harness({ AGY_TEST_MODELS_DELAY_MS: "120" });
    await h.connection.send({
      type: "session.open",
      requestId: "open-during-close",
      sessionId: "s",
      history: "skip",
      config: { cwd: h.cwd, env: {}, settings: {}, mcpServers: {}, persist: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await h.connection.close();

    const records = await h.records().catch(() => []);
    expect(records.filter((entry) => entry.args?.includes("acp"))).toEqual([]);
  });

  it("cancels prompt preparation before sending session/prompt when interrupted during reload", async () => {
    const h = await harness({ AGY_TEST_LOAD_DELAY_MS: "150" });
    await h.open();
    const png = await readFile(
      new URL("../test/fixtures/image-file-external.png", import.meta.url),
    );

    const clientMessageId = "prompt-cancel-prep";
    await h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "Should never reach session/prompt" },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.request({ type: "session.interrupt", requestId: "stop-prep", sessionId: "s" });

    const promptResult = h.events.find(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    expect(promptResult).toMatchObject({ result: { type: "turn" } });
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "session.turn", state: "canceled" }),
    );
    const interruptCompletedIdx = h.events.findIndex(
      (event) => event.type === "request.completed" && event.requestId === "stop-prep",
    );
    const turnCanceledIdx = h.events.findIndex(
      (event) => event.type === "session.turn" && event.state === "canceled",
    );
    expect(turnCanceledIdx).toBeGreaterThan(-1);
    expect(turnCanceledIdx).toBeLessThan(interruptCompletedIdx);
    expect((await h.records()).filter((entry) => entry.input)).toHaveLength(0);
  });

  it("preserves running model accounting during mid-turn switch and applies pending model: null reset on reload", async () => {
    const h = await harness({ AGY_TEST_LOAD_MODEL: "gemini-3.8-flash-high" });
    await h.open({ config: { model: "gemini-3.1-pro-high" } });

    const turn1MsgId = "prompt-pro-turn";
    await h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: turn1MsgId,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "DELAYED_USAGE" }] },
      },
    });
    const turnResult = await h.wait(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === turn1MsgId,
    );
    if (turnResult.type !== "session.prompt_result" || turnResult.result.type !== "turn") {
      throw new Error("Expected turn result");
    }
    const turn1Id = turnResult.result.turnId;

    // Queue a switch to gemini-3.8-flash-high while the Pro turn is still running.
    await h.request({
      type: "session.configure",
      requestId: "cfg-mid-flash",
      sessionId: "s",
      changes: { model: "gemini-3.8-flash-high" },
    });
    await h.wait(
      (event) =>
        event.type === "session.turn" && event.turnId === turn1Id && event.state === "completed",
    );

    const turn1Usage = h.events.find(
      (event) => event.type === "session.usage" && event.turnId === turn1Id,
    );
    // Gemini 3.1 Pro pricing (100k input @ $1.25/M = $0.125 + 10k output @ $5/M = $0.05 => $0.175) & 2M context window
    expect(turn1Usage).toMatchObject({
      type: "session.usage",
      usage: {
        contextWindowMaxTokens: 2_097_152,
        totalCostUsd: 0.175,
      },
    });

    // Start a second turn (switches to gemini-3.8-flash-high), and mid-turn queue model: null reset,
    // followed by an image prompt that reloads the driver via session/load.
    const turn2MsgId = "prompt-flash-turn";
    await h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: turn2MsgId,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "DELAYED_USAGE" }] },
      },
    });
    const turn2Result = await h.wait(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === turn2MsgId,
    );
    if (turn2Result.type !== "session.prompt_result" || turn2Result.result.type !== "turn") {
      throw new Error("Expected turn 2 result");
    }
    await h.request({
      type: "session.configure",
      requestId: "cfg-mid-reset",
      sessionId: "s",
      changes: { model: null },
    });
    await h.wait(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === turn2Result.result.turnId &&
        event.state === "completed",
    );

    const png = await readFile(
      new URL("../test/fixtures/image-file-external.png", import.meta.url),
    );
    await h.completed(
      await h.message([
        { type: "text", text: "Image after model reset" },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ]),
    );

    const records = await h.records();
    const setModelRpcs = records
      .filter((entry) => entry.rpc?.method === "session/set_model")
      .map((entry) => entry.rpc.params.modelId);
    expect(setModelRpcs.at(-1)).toBe("gemini-4-argon-medium");
  });

  // Closing fd 0 does not sever the inherited pipe on Windows, so gate this POSIX pipe-break fixture.
  it.skipIf(process.platform === "win32")(
    "fails the active turn and stops the driver when stdin breaks while agy stays alive",
    async () => {
      const h = await harness({ AGY_TEST_CLOSE_STDIN_AFTER_NEW: "yes" });
      await h.open();
      const msgId = await h.message([{ type: "text", text: "Trigger broken pipe" }]);
      const promptResult = h.events.find(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === msgId,
      );
      expect(promptResult).toMatchObject({ result: { type: "turn" } });
      if (promptResult?.type === "session.prompt_result" && promptResult.result.type === "turn") {
        const failedTurn = await h.wait(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === promptResult.result.turnId &&
            event.state === "failed",
        );
        expect(failedTurn).toMatchObject({ state: "failed" });
      }
      const records = await h.records();
      const acpPid = records.find((entry) => entry.args?.includes("acp"))?.pid;
      expect(typeof acpPid).toBe("number");
      await expect
        .poll(() => {
          try {
            process.kill(acpPid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    },
  );

  it("preserves a newer configure(model) chosen while a queued model switch is awaiting session/set_model", async () => {
    const h = await harness({ AGY_TEST_SET_MODEL_DELAY_MS: "80" });
    await h.open({ model: "gemini-4-argon-medium" });

    // Start turn 1 and queue model B mid-turn so modelDirty=true for turn 2 preparation.
    const turn1MsgPromise = h.message([{ type: "text", text: "DELAYED_USAGE turn 1" }]);
    const turn1Started = await h.wait(
      (event) => event.type === "session.turn" && event.state === "started",
    );
    await h.request({
      type: "session.configure",
      requestId: "queue-model-b",
      sessionId: "s",
      changes: { model: "gemini-3.1-pro-high" },
    });
    await turn1MsgPromise;
    if (turn1Started.type === "session.turn") {
      await h.wait(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === turn1Started.turnId &&
          event.state === "completed",
      );
    }

    // Start turn 2: preparation awaits session/set_model(B) for 80ms; choose model C during that wait.
    const turn2Promise = h.message([{ type: "text", text: "Turn 2 during B switch" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.request({
      type: "session.configure",
      requestId: "choose-model-c",
      sessionId: "s",
      changes: { model: "gemini-3.8-flash-low" },
    });
    const turn2MsgId = await turn2Promise;
    await h.completed(turn2MsgId);

    // Model C must still be active in config and applied on turn 3.
    expect(h.events.findLast((event) => event.type === "session.config")).toMatchObject({
      config: { model: "gemini-3.8-flash-low" },
    });
    await h.completed(await h.message([{ type: "text", text: "Turn 3 must use model C" }]));

    const inputs = (await h.records()).filter((entry) => entry.input).map((entry) => entry.input);
    expect(inputs.at(-1)?.model).toBe("gemini-3.8-flash-low");
  });

  it("serializes overlapping idle model changes so failure of a later switch preserves default model reset", async () => {
    const h = await harness({
      AGY_TEST_SET_MODEL_DELAY_MS: "60",
      AGY_TEST_FAIL_SET_MODEL_TARGET: "gemini-3.1-pro-high",
    });
    await h.open();

    const reqBPromise = h.request({
      type: "session.configure",
      requestId: "switch-to-b",
      sessionId: "s",
      changes: { model: "gemini-3.8-flash-low" },
    });
    const reqCPromise = h.request({
      type: "session.configure",
      requestId: "switch-to-c",
      sessionId: "s",
      changes: { model: "gemini-3.1-pro-high" },
    });

    await reqBPromise;
    await reqCPromise;

    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "request.failed",
        requestId: "switch-to-c",
      }),
    );

    await h.request({
      type: "session.configure",
      requestId: "reset-to-default",
      sessionId: "s",
      changes: { model: null },
    });

    expect(h.events.findLast((event) => event.type === "session.config")).toMatchObject({
      config: { model: "gemini-4-argon-medium" },
    });

    const setModelCalls = (await h.records())
      .filter((entry) => entry.rpc?.method === "session/set_model")
      .map((entry) => entry.rpc.params.modelId);

    expect(setModelCalls).toEqual([
      "gemini-3.8-flash-low",
      "gemini-3.1-pro-high",
      "gemini-4-argon-medium",
    ]);
  });

  it("retains notification-only costs across turns and replay when prompt completions omit usage", async () => {
    const h = await harness();
    await h.open();

    // Turn 1: receives usage_update with $1.0 cost, but prompt completion omits usage.
    const turn1Id = await h.message([{ type: "text", text: "NOTIFICATION_COST_TURN_1" }]);
    await h.completed(turn1Id);

    const usageAfterTurn1 = h.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.usage" }> =>
        event.type === "session.usage",
    );
    expect(usageAfterTurn1?.usage.totalCostUsd).toBe(1.0);

    // Turn 2: completion has tokens (1,000 input, 200 output on gemini-4-argon) and no explicit cost.
    // 1,000 in @ $1.25/M = $0.00125; 200 out @ $5.00/M = $0.001 -> $0.00225 added to $1.0 = $1.00225.
    const turn2Id = await h.message([{ type: "text", text: "ESTIMATED_TOKENS_TURN_2" }]);
    await h.completed(turn2Id);

    const usageAfterTurn2 = h.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.usage" }> =>
        event.type === "session.usage",
    );
    expect(usageAfterTurn2?.usage.totalCostUsd).toBe(1.00225);

    // Replay: load an existing conversation whose history updates contain $1.0 cost.
    const h2 = await harness({ AGY_TEST_REPLAY_COST: "1.0" });
    await h2.open({
      restored: { version: 1, data: { conversationId: "conv-alpha-1" } },
    });

    // Run Turn 1 on restored session: token estimate must accumulate on top of the replayed $1.0.
    const turn3Id = await h2.message([{ type: "text", text: "ESTIMATED_TOKENS_TURN_2" }]);
    await h2.completed(turn3Id);

    const usageAfterTurn3 = h2.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.usage" }> =>
        event.type === "session.usage",
    );
    expect(usageAfterTurn3?.usage.totalCostUsd).toBe(1.00225);
  });

  it.skipIf(process.platform === "win32")(
    "reaps surviving tool subprocesses in the POSIX group when the ACP leader crashes",
    async () => {
      const h = await harness();
      await h.open();
      const msgId = await h.message([{ type: "text", text: "CRASH_WITH_ORPHAN" }]);
      const promptResult = h.events.find(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === msgId,
      );
      if (promptResult?.type === "session.prompt_result" && promptResult.result.type === "turn") {
        await h.wait(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === promptResult.result.turnId &&
            event.state === "failed",
        );
      }
      const orphanPid = (await h.records()).find((entry) => entry.orphanPid)?.orphanPid;
      expect(typeof orphanPid).toBe("number");
      await expect
        .poll(() => {
          try {
            process.kill(orphanPid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    },
  );

  it("replays hundreds of chunked history updates in order using indexed lookup", async () => {
    const h = await harness({ AGY_TEST_REPLAY_CHUNKS: "250" });
    await h.open({
      restored: { version: 1, data: { conversationId: "conv-bulk-1" } },
      history: "replay",
    });
    const assistantItems = h.events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(assistantItems).toHaveLength(51);
    expect(assistantItems[0]).toMatchObject({
      id: "agent_message_chunk:bulk-0",
      text: "c0c1c2c3c4",
    });
    expect(assistantItems[49]).toMatchObject({
      id: "agent_message_chunk:bulk-49",
      text: "c0c1c2c3c4",
    });
    expect(assistantItems[50]).toMatchObject({
      id: "agent_message_chunk:replay-a1",
      text: "REPLAYED_ASSISTANT",
    });
  });

  it("matches session-scoped usage accounts when both default and custom --app-data-dir stores exist under the same HOME", async () => {
    const customHome = await mkdtemp(path.join(os.tmpdir(), "agy-custom-home-"));
    temporary.push(customHome);
    const customStore = path.join(customHome, "custom-store");
    const usage = new Usage({ home: customHome });
    // Remember default store first, then custom store under the same HOME.
    usage.remember({
      command: process.execPath,
      args: [fake],
      env: { HOME: customHome },
    });
    usage.remember({
      command: process.execPath,
      args: [fake, "--app-data-dir", customStore],
      env: { HOME: customHome },
    });
    const discovered = await usage.registration().discover({
      kind: "session",
      provider: "antigravity",
      args: [fake, "--app-data-dir", customStore],
      env: { HOME: customHome },
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.key).toBe(usage.accountKey(["--app-data-dir", customStore], {}));
  });

  it("drains in-flight attachment preparation without spawning a leaked process on session.close", async () => {
    const h = await harness();
    await h.open();
    const png = await readFile(
      fileURLToPath(new URL("../test/fixtures/image-file-external.png", import.meta.url)),
    );
    const promptPromise = h.request({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "close-during-prep",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "Close during image reload" },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ],
        },
      },
    });
    await h.request({ type: "session.close", requestId: "close-s", sessionId: "s" });
    await promptPromise;
    await h.wait((event) => event.type === "session.closed" && event.sessionId === "s");

    const acpPids = (await h.records())
      .filter((entry) => entry.args?.includes("acp") && typeof entry.pid === "number")
      .map((entry) => entry.pid as number);
    for (const pid of acpPids) {
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
  });

  it("does not auto-approve unapproved MCP tools with image directory arguments", async () => {
    const h = await harness();
    await h.open();
    const png = await readFile(
      new URL("../test/fixtures/image-file-external.png", import.meta.url),
    );
    const turn = await h.message([
      { type: "text", text: "WITH_MCP_UNAPPROVED" },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
    const perm = await h.wait(
      (event) =>
        event.type === "session.permission" && event.request.name === "mcp__external__delete_file",
    );
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: perm.request.id,
      response: { behavior: "deny" },
    });
    await h.completed(turn);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "assistant_message",
          text: "MCP_IMAGE_DENIED\n",
        }),
      }),
    );
  });

  it("normalizes ACP cachedReadTokens into cachedInputTokens at the wire boundary", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("CACHED_READ_TOKENS_TURN");
    await h.completed(turn);
    const usage = h.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.usage" }> =>
        event.type === "session.usage",
    );
    expect(usage?.usage.cachedInputTokens).toBe(500);
  });

  it("preserves primitive types and omits unanswered optional enum properties in elicitation", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("ASK_QUESTION_TYPES");
    const questionPerm = await h.wait(
      (event) => event.type === "session.permission" && event.request.kind === "question",
    );
    if (questionPerm.type !== "session.permission") throw new Error("Expected question permission");
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: questionPerm.request.id,
      response: {
        behavior: "allow",
        updatedInput: {
          answers: {
            approved: "false",
            count: "3",
            // optionalEnum omitted
          },
        },
      },
    });
    await h.completed(turn);
    const assistant = h.events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant).toMatchObject({
      type: "timeline.item",
      item: {
        type: "assistant_message",
        text: 'QUESTION_TYPES_RESULT:{"action":"accept","content":{"approved":false,"count":3}}\n',
      },
    });
  });

  it("allocates distinct plan identities across replayed turn boundaries", async () => {
    const h = await harness({ AGY_TEST_REPLAY_SUCCESSIVE_PLANS: "1" });
    await h.open({
      restored: { version: 1, data: { conversationId: "conv-alpha-1" } },
      history: "replay",
    });
    const timelineEvents = h.events.filter(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item",
    );
    const todos = timelineEvents
      .map((e) => e.item)
      .filter(
        (item): item is Extract<ProviderTimelineItem, { type: "todo" }> => item.type === "todo",
      );
    expect(todos.length).toBe(2);
    expect(todos[0]!.id).not.toBe(todos[1]!.id);
  });

  it("preserves plan identities across mid-turn tool calls", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("PLAN_ACROSS_TOOL_CALL");
    await h.completed(turn);

    const timelineEvents = h.events.filter(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item",
    );
    const todos = timelineEvents
      .map((e) => e.item)
      .filter(
        (item): item is Extract<ProviderTimelineItem, { type: "todo" }> => item.type === "todo",
      );
    expect(todos.length).toBeGreaterThanOrEqual(2);
    expect(todos[0]!.id).toBe(todos[1]!.id);
  });

  it("disambiguates duplicate titles in elicitation schemas so answers do not overwrite", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("ASK_QUESTION_DUPLICATE_TITLES");
    const questionPerm = await h.wait(
      (event) => event.type === "session.permission" && event.request.kind === "question",
    );
    if (questionPerm.type !== "session.permission") throw new Error("Expected question permission");

    expect(questionPerm.request.input).toMatchObject({
      questions: [
        expect.objectContaining({ id: "step1", header: "Confirmation (1)" }),
        expect.objectContaining({ id: "step2", header: "Confirmation (2)" }),
      ],
    });

    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: questionPerm.request.id,
      response: {
        behavior: "allow",
        updatedInput: {
          answers: {
            "Confirmation (1)": true,
            "Confirmation (2)": false,
          },
        },
      },
    });
    await h.completed(turn);

    const assistant = h.events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant).toMatchObject({
      type: "timeline.item",
      item: {
        type: "assistant_message",
        text: 'DUPLICATE_TITLES_RESULT:{"action":"accept","content":{"step1":true,"step2":false}}\n',
      },
    });
  });

  it("cancels and settles the active turn on interrupting permission denial", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("TOOLS");
    const perm = await h.wait(
      (event) => event.type === "session.permission" && event.request.name === "run_command",
    );
    if (perm.type !== "session.permission") throw new Error("Expected tool permission");

    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: perm.request.id,
      response: { behavior: "deny", interrupt: true },
    });

    expect(await h.completed(turn)).toMatchObject({ state: "canceled" });
  });

  it("emits session.runtime_failed when ACP process exits unexpectedly between turns", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("EXIT_IDLE_AFTER_TURN");
    await h.completed(turn);

    const runtimeFailed = await h.wait((event) => event.type === "session.runtime_failed");
    expect(runtimeFailed).toMatchObject({
      type: "session.runtime_failed",
      sessionId: "s",
    });
  });

  it("rejects answer-key fallbacks belonging to another question's header", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("ASK_QUESTION_FALLBACK_COLLISION");
    const questionPerm = await h.wait(
      (event) => event.type === "session.permission" && event.request.kind === "question",
    );
    if (questionPerm.type !== "session.permission") throw new Error("Expected question permission");

    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: questionPerm.request.id,
      response: {
        behavior: "allow",
        updatedInput: {
          answers: {
            first: "No",
          },
        },
      },
    });
    await h.completed(turn);

    const assistant = h.events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant).toMatchObject({
      type: "timeline.item",
      item: {
        type: "assistant_message",
        text: 'FALLBACK_COLLISION_RESULT:{"action":"accept","content":{"x":"No"}}\n',
      },
    });
  });

  it("prefers one-shot permission options over lasting options regardless of wire order", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("TOOLS_PRIORITY");
    const toolPerm = await h.wait(
      (event) => event.type === "session.permission" && event.request.kind === "tool",
    );
    if (toolPerm.type !== "session.permission") throw new Error("Expected tool permission");

    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: toolPerm.request.id,
      response: { behavior: "allow" },
    });
    await h.completed(turn);

    const assistant = h.events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant).toMatchObject({
      type: "timeline.item",
      item: {
        type: "assistant_message",
        text: "PRIORITY_RESULT:allow-once\n",
      },
    });
  });

  it("persists accumulated session cost across resumes when cost is estimated from tokens", async () => {
    const h1 = await harness();
    await h1.open();

    const turn1Id = await h1.message([{ type: "text", text: "ESTIMATED_TOKENS_TURN_2" }]);
    await h1.completed(turn1Id);

    const persistence1 = h1.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.persistence" }> =>
        event.type === "session.persistence",
    );
    expect(persistence1?.persistence.data).toMatchObject({
      conversationId: expect.any(String),
      accumulatedCostUsd: 0.00225,
    });
    if (!persistence1) throw new Error("Expected session persistence event");
    const conversationId = (persistence1.persistence.data as { conversationId: string })
      .conversationId;
    await h1.request({ type: "session.close", sessionId: "s", requestId: "close-1" });

    const h2 = await harness();
    await h2.open({ restored: persistence1?.persistence });

    const turn2Id = await h2.message([{ type: "text", text: "ESTIMATED_TOKENS_TURN_2" }]);
    await h2.completed(turn2Id);

    const usageAfterTurn2 = h2.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.usage" }> =>
        event.type === "session.usage",
    );
    expect(usageAfterTurn2?.usage.totalCostUsd).toBe(0.0045);

    const persistence2 = h2.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.persistence" }> =>
        event.type === "session.persistence",
    );
    expect(persistence2?.persistence.data).toMatchObject({
      conversationId,
      accumulatedCostUsd: 0.0045,
    });
    await h2.request({ type: "session.close", sessionId: "s", requestId: "close-2" });
  });

  it("persists notification-only session cost across resumes when prompt completions omit usage", async () => {
    const h1 = await harness();
    await h1.open();

    const turn1Id = await h1.message([{ type: "text", text: "NOTIFICATION_COST_TURN_1" }]);
    await h1.completed(turn1Id);

    const persistence1 = h1.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.persistence" }> =>
        event.type === "session.persistence",
    );
    expect(persistence1?.persistence.data).toMatchObject({
      conversationId: expect.any(String),
      accumulatedCostUsd: 1.0,
    });
    if (!persistence1) throw new Error("Expected session persistence event");
    const conversationId = (persistence1.persistence.data as { conversationId: string })
      .conversationId;
    await h1.request({ type: "session.close", sessionId: "s", requestId: "close-1" });

    const h2 = await harness();
    await h2.open({ restored: persistence1.persistence });

    const turn2Id = await h2.message([{ type: "text", text: "ESTIMATED_TOKENS_TURN_2" }]);
    await h2.completed(turn2Id);

    const usageAfterTurn2 = h2.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.usage" }> =>
        event.type === "session.usage",
    );
    expect(usageAfterTurn2?.usage.totalCostUsd).toBe(1.00225);

    const persistence2 = h2.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.persistence" }> =>
        event.type === "session.persistence",
    );
    expect(persistence2?.persistence.data).toMatchObject({
      conversationId,
      accumulatedCostUsd: 1.00225,
    });
    await h2.request({ type: "session.close", sessionId: "s", requestId: "close-2" });
  });

  it("preserves literal Other enum choices without a companion field as ordinary options", async () => {
    const h = await harness();
    await h.open();
    const turn = await h.prompt("ASK_QUESTION_LITERAL_OTHER");
    const questionPerm = await h.wait(
      (event) => event.type === "session.permission" && event.request.kind === "question",
    );
    if (questionPerm.type !== "session.permission") throw new Error("Expected question permission");

    expect(questionPerm.request).toMatchObject({
      name: "ask_question",
      kind: "question",
      input: {
        questions: [
          {
            id: "choice",
            header: "Choice",
            options: [{ label: "Yes" }, { label: "No" }, { label: "Other" }],
            allowOther: false,
          },
        ],
      },
    });

    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: questionPerm.request.id,
      response: {
        behavior: "allow",
        updatedInput: {
          answers: {
            Choice: "Other",
          },
        },
      },
    });
    await h.completed(turn);

    const assistant = h.events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant).toMatchObject({
      type: "timeline.item",
      item: {
        type: "assistant_message",
        text: 'LITERAL_OTHER_RESULT:{"action":"accept","content":{"choice":"Other"}}\n',
      },
    });
  });

  it("preserves the original default model across session resumes when model: null is configured", async () => {
    const h1 = await harness();
    await h1.open();

    await h1.request({
      type: "session.configure",
      requestId: "set-model",
      sessionId: "s",
      changes: { model: "gemini-3.8-flash-low" },
    });

    const persistence1 = h1.events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.persistence" }> =>
        event.type === "session.persistence",
    );
    expect(persistence1?.persistence.data).toMatchObject({
      conversationId: expect.any(String),
      model: "gemini-3.8-flash-low",
      defaultModelId: "gemini-4-argon-medium",
    });
    if (!persistence1) throw new Error("Expected session persistence event");
    await h1.request({ type: "session.close", sessionId: "s", requestId: "close-1" });

    const h2 = await harness();
    await h2.open({ restored: persistence1.persistence });

    await h2.request({
      type: "session.configure",
      requestId: "reset-model",
      sessionId: "s",
      changes: { model: null },
    });

    expect(h2.events.findLast((event) => event.type === "session.config")).toMatchObject({
      config: { model: "gemini-4-argon-medium" },
    });
    await h2.request({ type: "session.close", sessionId: "s", requestId: "close-2" });
  });

  it("retires driver and resynchronizes model on next turn when model switch times out", async () => {
    const h = await harness({
      AGY_TEST_INIT_TIMEOUT_MS: "200",
      AGY_TEST_SET_MODEL_DELAY_ONCE_MS: "600",
    });
    await h.open();

    await h.request({
      type: "session.configure",
      requestId: "set-model-timeout",
      sessionId: "s",
      changes: { model: "gemini-3.8-flash-low" },
    });

    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "request.failed",
        requestId: "set-model-timeout",
        error: expect.objectContaining({
          message: expect.stringContaining(
            "Timed out waiting for Antigravity ACP response to session/set_model",
          ),
        }),
      }),
    );

    const turn = await h.prompt("Hello after timeout");
    await h.completed(turn);

    expect(h.events.findLast((event) => event.type === "session.config")).toMatchObject({
      config: { model: "gemini-4-argon-medium" },
    });

    const acpProcesses = (await h.records()).filter((entry) => entry.args?.includes("acp"));
    expect(acpProcesses.length).toBeGreaterThanOrEqual(2);
  });

  it("fails clearly when a restored session trajectory has expired upstream", async () => {
    const h = await harness({ AGY_TEST_EXPIRED_TRAJECTORY_ID: "expired-session-id" });
    await h.open({
      restored: {
        version: 1,
        data: { conversationId: "expired-session-id" },
      },
    });

    const failed = h.events.find(
      (event): event is Extract<ProviderEvent, { type: "request.failed" }> =>
        event.type === "request.failed",
    );
    expect(failed?.error.message).toContain("trajectory has expired upstream");
  });

  it("rejects unsupported providerOptions and settings in session.configure", async () => {
    const h = await harness();
    await h.open();
    await h.request({
      type: "session.configure",
      requestId: "cfg-opts",
      sessionId: "s",
      changes: { providerOptions: { temperature: 0.7 } },
    });
    expect(
      h.events.find((event) => event.type === "request.failed" && event.requestId === "cfg-opts"),
    ).toMatchObject({
      type: "request.failed",
      error: {
        message: expect.stringContaining("Antigravity has no configurable options or settings"),
      },
    });

    await h.request({
      type: "session.configure",
      requestId: "cfg-settings",
      sessionId: "s",
      changes: { settings: { foo: "bar" } },
    });
    expect(
      h.events.find(
        (event) => event.type === "request.failed" && event.requestId === "cfg-settings",
      ),
    ).toMatchObject({
      type: "request.failed",
      error: {
        message: expect.stringContaining("Antigravity has no configurable options or settings"),
      },
    });
  });

  it("preserves comma-containing labels in multiselect elicitation answers", async () => {
    const h = await harness();
    await h.open();

    const turn = await h.prompt("ASK_QUESTION_COMMAS");
    const questionPerm = await h.wait(
      (event) => event.type === "session.permission" && event.request.kind === "question",
    );
    if (questionPerm.type !== "session.permission") throw new Error("Expected question permission");

    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: questionPerm.request.id,
      response: {
        behavior: "allow",
        updatedInput: {
          answers: {
            Cities: "Paris, France, Tokyo, Japan",
          },
        },
      },
    });
    await h.completed(turn);

    const assistant = h.events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant).toMatchObject({
      type: "timeline.item",
      item: {
        type: "assistant_message",
        text: 'COMMAS_RESULT:{"action":"accept","content":{"cities":["Paris, France","Tokyo, Japan"]}}\n',
      },
    });
  });

  it("formats review attachments with code context and marks target lines", async () => {
    const h = await harness();
    await h.open();

    const id = await h.message([
      {
        type: "review",
        cwd: "/test/repo",
        mode: "uncommitted",
        comments: [
          {
            filePath: "src/sample.ts",
            side: "right",
            lineNumber: 42,
            body: "Check this logic",
            context: {
              hunkHeader: "@@ -40,3 +40,4 @@",
              targetLine: {
                type: "add",
                content: "  const value = true;",
                oldLineNumber: null,
                newLineNumber: 42,
              },
              lines: [
                {
                  type: "context",
                  content: "function test() {",
                  oldLineNumber: 40,
                  newLineNumber: 40,
                },
                {
                  type: "add",
                  content: "  const value = true;",
                  oldLineNumber: null,
                  newLineNumber: 42,
                },
                {
                  type: "context",
                  content: "}",
                  oldLineNumber: 41,
                  newLineNumber: 43,
                },
              ],
            },
          },
        ],
      },
    ]);
    await h.completed(id);

    const record = (await h.records()).find((r) =>
      r.input?.message?.content?.includes("Code review (uncommitted changes in /test/repo):"),
    );
    expect(record).toBeDefined();
    const content = record!.input!.message!.content!;
    expect(content).toContain("Comment 1: src/sample.ts:right:42");
    expect(content).toContain("Check this logic");
    expect(content).toContain("@@ -40,3 +40,4 @@");
    expect(content).toContain("  40 40  function test() {");
    expect(content).toContain(">  - 42 +  const value = true;");
    expect(content).toContain("  41 43  }");
  });
});

it.runIf(process.platform === "win32")(
  "launches an Antigravity command shim for probes and conversation startup",
  async () => {
    const h = await harness();
    const shim = path.join(h.cwd, "agy launcher.cmd");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
    h.launch.command = shim;
    h.launch.args = ["--launch-prefix"];
    expect(await h.provider.status?.({ launch: h.launch })).toEqual({ available: true });
    await h.open();
    expect(await h.wait((event) => event.type === "session.opened")).toMatchObject({
      sessionId: "s",
    });
  },
);
