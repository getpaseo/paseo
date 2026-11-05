import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderContent,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderPersistence,
} from "@getpaseo/plugin/server/provider";
import { signalPlan } from "./internal/signals.js";
import { createAntigravityProvider } from "./provider.js";

const temporary: string[] = [];
const connections: ProviderConnection[] = [];
const fake = fileURLToPath(new URL("../test/agy.mjs", import.meta.url));
const provider = createAntigravityProvider();

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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
  temporary.push(cwd);
  const log = path.join(cwd, "argv.ndjson");
  const launch: ProviderLaunch = {
    command: process.execPath,
    args: [fake, "--launch-prefix"],
    env: { AGY_TEST_LOG: log, ...env },
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
    if ("requestId" in input)
      await wait(
        (event) =>
          "requestId" in event &&
          event.requestId === input.requestId &&
          (event.type === "request.completed" ||
            event.type === "request.failed" ||
            event.type === "session.ready" ||
            event.type === "catalog"),
      );
  }
  async function open(
    restored?: ProviderPersistence,
    sessionId = "s",
    mode?: string,
    history: "replay" | "skip" = "replay",
  ) {
    await request({
      type: "session.open",
      requestId: `open-${events.length}`,
      sessionId,
      persistence: restored,
      history,
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
        },
        persist: true,
        systemPrompt: "SYSTEM PREFIX",
        ...(mode ? { mode } : {}),
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
  function prompt(text: string) {
    return message([{ type: "text", text }]);
  }
  async function completed(clientMessageId: string) {
    const result = events.find(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    if (!result || result.type !== "session.prompt_result" || result.result.type !== "turn")
      throw new Error("Prompt was not admitted");
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
    if (!opened || opened.type !== "session.opened" || !opened.persistence)
      throw new Error("Missing persistence");
    return opened.persistence;
  }
  async function acpLaunches() {
    return (await records()).filter((entry) => entry.args?.includes("acp"));
  }
  async function modelChanges() {
    return (await records())
      .filter((entry) => entry.rpc?.method === "session/set_model")
      .map((entry) => entry.rpc.params as { sessionId: string; modelId: string });
  }
  async function selectedPermissionOptions() {
    return (await records())
      .filter((entry) => entry.rpc?.result?.outcome?.outcome === "selected")
      .map((entry) => entry.rpc.result.outcome.optionId as string);
  }
  async function hasRpcMethod(method: string) {
    return (await records()).some((entry) => entry.rpc?.method === method);
  }
  async function allowPermission(name?: string, sessionId = "s") {
    const perm = (await wait(
      (event) =>
        event.type === "session.permission" && (name === undefined || event.request.name === name),
    )) as Extract<ProviderEvent, { type: "session.permission" }>;
    await connection.send({
      type: "session.permission",
      sessionId,
      permissionId: perm.request.id,
      response: { behavior: "allow" },
    });
    return perm.request;
  }
  return {
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
    acpLaunches,
    modelChanges,
    selectedPermissionOptions,
    hasRpcMethod,
    allowPermission,
  };
}

it("starts via agy acp --stdio without full-access warnings, passes systemPrompt in _meta, and exposes slash commands", async () => {
  const h = await harness();
  expect(h.connection.capabilities).toEqual([
    "prompt.message",
    "prompt.command",
    "prompt.image",
    "session.configure",
    "session.persistence",
    "permission",
  ]);
  await h.open();
  expect(h.events.some((event) => event.type === "session.notice")).toBe(false);
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "session.config",
      sessionId: "s",
      config: expect.objectContaining({
        mode: "default",
        model: "gemini-4-argon-medium",
      }),
    }),
  );
  await h.wait((event) => event.type === "session.commands");
  expect(h.events).toContainEqual({
    type: "session.commands",
    sessionId: "s",
    commands: [
      { name: "plan", description: "Plan a task before execution", argumentHint: "<task>" },
      { name: "compact", description: "Compact conversation context" },
    ],
  });

  await h.completed(await h.prompt("HELLO"));
  await h.completed(await h.prompt("HELLO AGAIN"));
  const text = h.events.filter(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  expect(
    text.map((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message"
        ? event.item.text
        : "",
    ),
  ).toEqual(["PHASE0_HELLO", "PHASE0_HELLO\n", "PHASE0_HELLO", "PHASE0_HELLO\n"]);

  const records = await h.records();
  const launchEntry = records.find((entry) => entry.args?.includes("acp"));
  expect(launchEntry.args).toEqual(["--launch-prefix", "acp", "--stdio", "--add-dir", h.cwd]);
  expect(launchEntry.args).not.toContain("--dangerously-skip-permissions");
  expect(launchEntry.env).toBe("session-overlay");

  const sessionNewRpc = records.find((entry) => entry.rpc?.method === "session/new")?.rpc;
  expect(sessionNewRpc?.params).toMatchObject({
    cwd: h.cwd,
    mcpServers: [{ name: "test-mcp", command: "node", args: ["mcp.js"], env: [] }],
    _meta: {
      antigravity: {
        systemPrompt: { append: "SYSTEM PREFIX" },
      },
    },
  });
  expect(
    records.filter((entry) => entry.input).map((entry) => entry.input.message.content),
  ).toEqual(["HELLO", "HELLO AGAIN"]);
});

it("prompts for tool permission in default mode and resolves allow and deny responses", async () => {
  const h = await harness();
  await h.open();

  // Turn 1: Deny the shell command
  const firstPrompt = await h.prompt("TOOLS");
  const firstPermission = await h.wait(
    (event) => event.type === "session.permission" && event.request.kind === "tool",
  );
  if (firstPermission.type !== "session.permission") throw new Error("Expected permission");
  expect(firstPermission.request).toMatchObject({
    name: "run_command",
    kind: "tool",
    title: "printf PHASE0_SHELL",
    detail: { type: "shell", command: "printf PHASE0_SHELL" },
  });
  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: firstPermission.request.id,
    response: { behavior: "deny" },
  });
  await h.wait(
    (event) =>
      event.type === "session.permission_resolved" &&
      event.permissionId === firstPermission.request.id,
  );
  expect(await h.completed(firstPrompt)).toMatchObject({ state: "completed" });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        name: "run_command",
        status: "failed",
        detail: expect.objectContaining({ type: "shell", command: "printf PHASE0_SHELL" }),
      }),
    }),
  );

  // Turn 2: Allow the shell command
  const secondPrompt = await h.prompt("TOOLS");
  const secondPermission = await h.wait(
    (event) =>
      event.type === "session.permission" &&
      event.request.kind === "tool" &&
      event.request.id !== firstPermission.request.id,
  );
  if (secondPermission.type !== "session.permission") throw new Error("Expected permission");
  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: secondPermission.request.id,
    response: { behavior: "allow" },
  });
  expect(await h.completed(secondPrompt)).toMatchObject({ state: "completed" });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        name: "run_command",
        status: "completed",
        detail: expect.objectContaining({
          type: "shell",
          command: "printf PHASE0_SHELL",
          output: "PHASE0_SHELL",
        }),
      }),
    }),
  );
});

it("auto-approves edits in accept-edits mode while still prompting for shell commands, and auto-approves everything in full-access mode", async () => {
  const h = await harness();
  await h.open(undefined, "s", "accept-edits");

  const editAndShell = await h.prompt("EDIT_AND_SHELL");
  const shellPerm = await h.wait((event) => event.type === "session.permission");
  if (shellPerm.type !== "session.permission") throw new Error("Expected shell permission");
  // The edit tool was auto-approved; only the shell command requested permission!
  expect(shellPerm.request).toMatchObject({
    name: "run_command",
    kind: "tool",
    detail: { type: "shell", command: "npm test" },
  });

  // Switching mode to full-access while a permission is pending auto-approves it immediately!
  await h.request({
    type: "session.configure",
    requestId: "switch-full",
    sessionId: "s",
    changes: { mode: "full-access" },
  });
  expect(await h.completed(editAndShell)).toMatchObject({ state: "completed" });

  // In full-access mode, subsequent tool calls run without any session.permission prompt
  const permCountBefore = h.events.filter((event) => event.type === "session.permission").length;
  await h.completed(await h.prompt("TOOLS"));
  expect(h.events.filter((event) => event.type === "session.permission")).toHaveLength(
    permCountBefore,
  );
});

it("maps elicitation/create (ask_question) to a native question permission and returns user answers", async () => {
  const h = await harness();
  await h.open();

  const askTurn = await h.prompt("ASK_QUESTION");
  const questionEvent = await h.wait(
    (event) => event.type === "session.permission" && event.request.kind === "question",
  );
  if (questionEvent.type !== "session.permission") throw new Error("Expected question permission");
  expect(questionEvent.request).toMatchObject({
    name: "ask_question",
    kind: "question",
    title: "The agent has a question.",
    input: {
      questions: [
        {
          id: "q0",
          header: "Question",
          question: "Which UI library should we use?",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false,
          allowOther: true,
          allowEmpty: false,
        },
      ],
    },
  });

  await h.connection.send({
    type: "session.permission",
    sessionId: "s",
    permissionId: questionEvent.request.id,
    response: {
      behavior: "allow",
      updatedInput: {
        answers: {
          Question: "Svelte",
        },
      },
    },
  });

  expect(await h.completed(askTurn)).toMatchObject({ state: "completed" });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        type: "assistant_message",
        text: 'QUESTION_RESULT:{"action":"accept","content":{"q0":"Other","q0_other":"Svelte"}}\n',
      }),
    }),
  );
});

it("stays alive and completes turn when Antigravity logs transient API retry messages to stderr", async () => {
  const h = await harness();
  await h.open();
  const turn = await h.completed(await h.prompt("TRANSIENT_RETRY"));
  expect(turn).toMatchObject({ type: "session.turn", state: "completed" });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "timeline.item",
      item: expect.objectContaining({
        type: "assistant_message",
        text: "RECOVERED_AFTER_RETRY\n",
      }),
    }),
  );
  const launches = (await h.records()).filter((entry) => entry.args?.includes("acp"));
  expect(launches).toHaveLength(1);
});

it("streams reasoning, usage updates, and resumes session via session/load with history replay or skip", async () => {
  const h = await harness();
  await h.open();
  await h.completed(await h.prompt("MULTI"));
  await h.completed(await h.prompt("MULTI"));
  const usages = h.events.filter((event) => event.type === "session.usage");
  expect(
    usages.map((event) => (event.type === "session.usage" ? event.usage.inputTokens : null)),
  ).toEqual([11263, 11604]);
  expect(
    h.events.some((event) => event.type === "timeline.item" && event.item.type === "reasoning"),
  ).toBe(true);

  const persistence = h.persistence();
  await h.request({ type: "session.close", sessionId: "s", requestId: "close" });

  const second = await harness();
  await second.open(persistence);
  expect(
    second.events
      .filter((event) => event.type === "timeline.item")
      .map((event) => (event.type === "timeline.item" ? event.item : null)),
  ).toEqual([
    {
      type: "user_message",
      id: "user_message_chunk:replay-u1",
      messageId: "replay-u1",
      text: "REPLAYED_USER",
    },
    {
      type: "assistant_message",
      id: "agent_message_chunk:replay-a1",
      messageId: "replay-a1",
      text: "REPLAYED_ASSISTANT",
    },
  ]);
  await second.completed(await second.prompt("RESUME"));
  expect(second.events.findLast((event) => event.type === "session.usage")).toMatchObject({
    usage: { inputTokens: 11815 },
  });

  const third = await harness();
  await third.open(persistence, "s", undefined, "skip");
  expect(third.events.filter((event) => event.type === "timeline.item")).toEqual([]);
});

it("maps subagent steps to a tool carrying the child conversation ID", async () => {
  const h = await harness();
  await h.open();
  await h.completed(await h.prompt("SUBAGENT"));
  expect(h.events).toEqual(
    expect.arrayContaining([
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
    ]),
  );
});

it.each(["HANG", "TOOL_HANG"])(
  "cancels %s cleanly via ACP session/cancel without killing the process",
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
    expect(await h.acpLaunches()).toHaveLength(1);
    expect(await h.hasRpcMethod("session/cancel")).toBe(true);
  },
);

it("stops an unresponsive driver that ignores session/cancel and signals, then reloads the conversation on next prompt", async () => {
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
  expect(
    h.events.some(
      (event) =>
        event.type === "timeline.item" &&
        (event.item.type === "user_message" || event.item.type === "assistant_message") &&
        event.item.text.startsWith("REPLAYED_"),
    ),
  ).toBe(false);
  expect(await h.acpLaunches()).toHaveLength(2);
  expect(await h.hasRpcMethod("session/load")).toBe(true);
});

it("switches models dynamically via session/set_model without respawning the process, and rejects invalid models/modes", async () => {
  const h = await harness();
  await h.open();
  await h.request({
    type: "session.configure",
    requestId: "change",
    sessionId: "s",
    changes: { model: "gemini-3.8-flash-low", mode: "accept-edits" },
  });
  await h.completed(await h.prompt("HELLO"));
  expect(
    h.events.some(
      (event) =>
        event.type === "timeline.item" &&
        (event.item.type === "user_message" || event.item.type === "assistant_message") &&
        event.item.text.startsWith("REPLAYED_"),
    ),
  ).toBe(false);
  expect(await h.acpLaunches()).toHaveLength(1);
  expect(await h.modelChanges()).toEqual([
    {
      sessionId: "e5cf1e2d-c715-4328-8e67-4a85c8dc3cda",
      modelId: "gemini-3.8-flash-low",
    },
  ]);

  await h.request({
    type: "session.configure",
    requestId: "clear-model",
    sessionId: "s",
    changes: { model: null },
  });
  expect((await h.modelChanges()).map((change) => change.modelId)).toEqual([
    "gemini-3.8-flash-low",
    "gemini-4-argon-medium",
  ]);

  await h.request({
    type: "session.configure",
    requestId: "invalid-mode",
    sessionId: "s",
    changes: { mode: "plan" },
  });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "request.failed",
      requestId: "invalid-mode",
      error: { code: "INVALID_MODE", message: "Unknown Antigravity mode: plan" },
    }),
  );

  await h.request({
    type: "session.configure",
    requestId: "invalid-model",
    sessionId: "s",
    changes: { model: "unknown" },
  });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "request.failed",
      requestId: "invalid-model",
      error: expect.objectContaining({ code: "INVALID_MODEL" }),
    }),
  );
});

it("keeps the previous model when session/set_model fails so a retry succeeds", async () => {
  const h = await harness({ AGY_TEST_FAIL_SET_MODEL_ONCE: "yes" });
  await h.open();
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
    }),
  );
  await h.request({
    type: "session.configure",
    requestId: "set-model-retry",
    sessionId: "s",
    changes: { model: "gemini-3.8-flash-low" },
  });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "request.completed",
      requestId: "set-model-retry",
    }),
  );
  expect(await h.acpLaunches()).toHaveLength(1);
  expect((await h.modelChanges()).map((change) => change.modelId)).toEqual([
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-low",
  ]);
});

it("prompts for external MCP tools with a query field in accept-edits mode and prefers allow_once", async () => {
  const h = await harness();
  await h.open(undefined, "s", "accept-edits");
  const id = await h.prompt("MCP_QUERY_TOOL");
  await h.allowPermission("mcp__db__query");
  await h.completed(id);
  expect(await h.selectedPermissionOptions()).toEqual(["allow_once"]);
});

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

it("rejects mid-turn steering and reports a busy message without queueing a second native turn", async () => {
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

describe("discovery", () => {
  it("reuses one discovered catalog for two opens and configure, and refreshes explicit catalog requests", async () => {
    const h = await harness();
    await h.open();
    await h.open(undefined, "second");
    await h.request({
      type: "session.configure",
      requestId: "configure-cached",
      sessionId: "second",
      changes: { model: "gemini-3.8-flash-low" },
    });
    expect(
      (await h.records()).filter((entry) => entry.args && entry.args.includes("models")),
    ).toHaveLength(1);
    await h.request({ type: "catalog", requestId: "refresh" });
    expect(
      (await h.records()).filter((entry) => entry.args && entry.args.includes("models")),
    ).toHaveLength(2);
  });

  it.each(["1.1.15", "1.2.12", "1.2.13", "1.4.1"])(
    "accepts driver-capable version %s",
    async (version) => {
      const h = await harness({ AGY_TEST_VERSION: version });
      expect(await provider.status?.({ launch: h.launch })).toEqual({ available: true });
    },
  );

  it("parses tab-separated catalog and exposes default, accept-edits, and full-access modes", async () => {
    const h = await harness();
    await h.request({ type: "catalog", requestId: "catalog" });
    const event = h.events[0];
    expect(event).toMatchObject({
      type: "catalog",
      catalog: {
        models: expect.arrayContaining([
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        ]),
        thinkingOptions: [],
        defaultMode: "default",
      },
    });
    if (event.type !== "catalog") throw new Error("Missing catalog");
    expect(event.catalog.models).toHaveLength(11);
    expect(event.catalog.modes).toEqual([
      {
        id: "default",
        label: "Default",
        icon: "ShieldCheck",
        colorTier: "safe",
        description: "Asks for permission before running shell commands or editing files.",
      },
      {
        id: "accept-edits",
        label: "Accept edits",
        icon: "ShieldAlert",
        colorTier: "moderate",
        description: "Automatically approves file edits and asks before running shell commands.",
      },
      {
        id: "full-access",
        label: "Full access",
        icon: "ShieldOff",
        colorTier: "dangerous",
        isUnattended: true,
        description: "Automatically approves all tool calls and shell commands without asking.",
      },
    ]);
  });

  it("reports missing, old, unauthenticated and available launches", async () => {
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
    const old = await harness({ AGY_TEST_VERSION: "1.1.14" });
    expect(await provider.status?.({ launch: old.launch })).toMatchObject({
      available: false,
      diagnostic: expect.stringContaining("1.1.15"),
    });
    const unauthenticated = await harness({ AGY_TEST_AUTH: "missing" });
    expect(await provider.status?.({ launch: unauthenticated.launch })).toEqual({
      available: false,
      diagnostic: "Antigravity authentication failed. Run `agy` and sign in, then retry.",
    });
    const authenticated = await harness();
    expect(await provider.status?.({ launch: authenticated.launch })).toEqual({ available: true });
  });

  it("keys catalog caching by the complete effective launch without exposing env values", async () => {
    const h = await harness();
    const key = await provider.getCatalogCacheKey?.({ scope: "global", launch: h.launch });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await provider.getCatalogCacheKey?.({
        scope: "workspace",
        cwd: h.cwd,
        force: true,
        launch: h.launch,
      }),
    ).toBe(key);
    expect(
      await provider.getCatalogCacheKey?.({
        scope: "global",
        launch: { ...h.launch, args: [...h.launch.args, "changed"] },
      }),
    ).not.toBe(key);
    expect(
      await provider.getCatalogCacheKey?.({
        scope: "global",
        launch: { ...h.launch, env: { ...h.launch.env, HOME: "different" } },
      }),
    ).not.toBe(key);
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

describe("image prompts", () => {
  it.each(["session", "connection"])(
    "encodes mixed content as private session files, auto-approves session image reads in default mode, and cleans up on %s close",
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
          { type: "text", text: "Compare them." },
          { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
        ]),
      );
      const sent = (await h.records()).find((entry) => entry.input).input.message.content;
      const lines = sent.split("\n");
      const pngPath = lines[1].slice("Attached image: ".length);
      const jpegPath = lines[3].slice("Attached image: ".length);
      expect(sent).toBe(
        `Describe these images.\nAttached image: ${pngPath}\nCompare them.\nAttached image: ${jpegPath}`,
      );
      expect(path.isAbsolute(pngPath)).toBe(true);
      expect(path.extname(pngPath)).toBe(".png");
      expect(path.extname(jpegPath)).toBe(".jpg");
      expect(path.dirname(pngPath)).toBe(path.dirname(jpegPath));
      expect(path.dirname(pngPath)).not.toBe(h.cwd);
      expect(await readFile(pngPath)).toEqual(png);
      expect(await readFile(jpegPath)).toEqual(jpeg);
      if (process.platform !== "win32") {
        expect((await stat(path.dirname(pngPath))).mode & 0o777).toBe(0o700);
        expect((await stat(pngPath)).mode & 0o777).toBe(0o600);
        expect((await stat(jpegPath)).mode & 0o777).toBe(0o600);
      }
      // Reading the attached image in default mode was auto-approved without a permission prompt
      expect(h.events.filter((event) => event.type === "session.permission")).toHaveLength(0);
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({ type: "assistant_message", text: "IMAGE_READ_OK\n" }),
        }),
      );
      if (close === "connection") await h.connection.close();
      else await h.request({ type: "session.close", requestId: "close-images", sessionId: "s" });
      await expect(stat(path.dirname(pngPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps image-only prompts in distinct session directories until each session closes", async () => {
    const h = await harness();
    await h.open();
    await h.open(undefined, "other");
    const content: ProviderContent[] = [
      { type: "image", data: "aW1hZ2U=", mimeType: "image/webp" },
    ];
    await h.completed(await h.message(content));
    await h.completed(await h.message(content));
    await h.completed(await h.message(content, "other"));
    const paths = (await h.records())
      .filter((entry) => entry.input)
      .map((entry) => entry.input.message.content.split("Attached image: ")[1]);
    expect(new Set(paths).size).toBe(3);
    expect(path.dirname(paths[0])).toBe(path.dirname(paths[1]));
    expect(path.dirname(paths[0])).not.toBe(path.dirname(paths[2]));
    expect(paths.every((file: string) => path.extname(file) === ".webp")).toBe(true);
    await h.request({ type: "session.close", requestId: "close-first", sessionId: "s" });
    await expect(stat(path.dirname(paths[0]))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(paths[2], "utf8")).toBe("image");
    await h.connection.close();
    await expect(stat(path.dirname(paths[2]))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-image MIME type before writing to native stdin", async () => {
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

it.runIf(process.platform === "win32")(
  "launches an Antigravity command shim for probes and conversation startup",
  async () => {
    const h = await harness();
    const shim = path.join(h.cwd, "agy launcher.cmd");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
    h.launch.command = shim;
    h.launch.args = ["--launch-prefix"];
    expect(await provider.status!({ launch: h.launch })).toEqual({ available: true });
    await h.open();
    expect(await h.wait((event) => event.type === "session.opened")).toMatchObject({
      sessionId: "s",
    });
  },
);
