import { spawn } from "node:child_process";
import { appendFileSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = process.env.AGY_TEST_LOG;
function record(value) {
  if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
}
record({
  args,
  pid: process.pid,
  env: process.env.AGY_SESSION_VALUE,
  noColor: process.env.NO_COLOR,
});

function fixture(name, stream = "stdout") {
  return readFileSync(new URL(`./fixtures/${name}.${stream}.ndjson`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).data);
}

if (args.includes("--version")) {
  process.stdout.write(`${process.env.AGY_TEST_VERSION || "1.4.12"}\n`);
  process.exit(0);
}

if (args.includes("acp") && (args.includes("--help") || args.includes("-h"))) {
  if (process.env.AGY_TEST_NO_ACP === "yes") {
    process.stderr.write('unknown subcommand "acp"\n');
    process.exit(1);
  }
  process.stdout.write("Usage: agy acp [flags]\n");
  process.exit(0);
}

if (args.includes("models")) {
  if (process.env.AGY_TEST_MODELS_DELAY_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.AGY_TEST_MODELS_DELAY_MS)),
    );
  }
  if (process.env.AGY_TEST_AUTH === "missing") {
    process.stderr.write(fixture("models-unauthenticated", "stderr").join("\n"));
    process.exit(1);
  }
  process.stdout.write(`${fixture("models-api-key").join("\n")}\n`);
  process.exit(0);
}

const printIdx = args.indexOf("--print");
if (printIdx !== -1) {
  const command = args[printIdx + 1];
  if (process.env.AGY_TEST_USAGE_AUTH === "missing" || process.env.AGY_TEST_AUTH === "missing") {
    process.stderr.write("Error: authentication required. Run `agy` and sign in.\n");
    process.exit(1);
  }
  if (command === "/usage") {
    if (process.env.AGY_TEST_USAGE_EMPTY === "yes") {
      process.stdout.write("\n");
      process.exit(0);
    }
    process.stdout.write(
      process.env.AGY_TEST_USAGE_OUTPUT ||
        [
          "Quota",
          "Gemini          5-hour limit    82%  2026-11-04 01:00 -03",
          "Gemini          Weekly limit    65%  2026-11-10 20:28 -03",
          "Gemini 4 Argon  Weekly limit    90%  2026-11-10 20:28 -03",
          "Claude & GPT    5-hour limit    20%  2026-11-04 01:00 -03",
          "Claude & GPT    Weekly limit    50%  2026-11-10 20:28 -03",
          "",
        ].join("\n"),
    );
    process.exit(0);
  }
  if (command === "/credits") {
    if (process.env.AGY_TEST_CREDITS_EMPTY === "yes") {
      process.stdout.write("\n");
      process.exit(0);
    }
    process.stdout.write(process.env.AGY_TEST_CREDITS_OUTPUT || "Remaining credits  42.5\n");
    process.exit(0);
  }
}

if (process.env.AGY_TEST_STARTUP === "auth") {
  process.stderr.write(fixture("not-signed-in", "stderr").join("\n"));
  process.exit(1);
}
if (process.env.AGY_TEST_STARTUP === "exit") process.exit(3);
if (process.env.AGY_TEST_STARTUP === "stderr") {
  process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
  process.exit(1);
}

const DEFAULT_SESSION_ID = "e5cf1e2d-c715-4328-8e67-4a85c8dc3cda";
let sessionId = DEFAULT_SESSION_ID;
let currentModel = "gemini-4-argon-medium";
let nextServerRpcId = 1000;
let multiTurnCount = 0;
let activePromptId = null;
let failSetModelOnce = process.env.AGY_TEST_FAIL_SET_MODEL_ONCE === "yes";
let failSetModelTarget = process.env.AGY_TEST_FAIL_SET_MODEL_TARGET;
const pendingClientRequests = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notifyUpdate(update) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update,
    },
  });
}

function requestClient(method, params) {
  const id = nextServerRpcId++;
  return new Promise((resolve) => {
    pendingClientRequests.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function handlePrompt(id, params) {
  const text = (params.prompt || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  record({ input: { message: { content: text }, model: currentModel } });

  if (text.includes("HANG") || text.includes("TOOL_HANG")) {
    handleHangPrompt(id, text);
    return;
  }
  if (text.includes("CRASH_WITH_ORPHAN")) {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    orphan.unref();
    record({ orphanPid: orphan.pid });
    process.exit(1);
  }
  if (text.includes("DELAYED_USAGE")) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `MODEL_USED:${currentModel}\n` },
    });
    respond(id, {
      stopReason: "end_turn",
      usage: {
        inputTokens: 100_000,
        outputTokens: 10_000,
      },
    });
    return;
  }
  if (text.includes("SPAWN_ORPHAN")) {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    orphan.unref();
    record({ orphanPid: orphan.pid });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `ORPHAN:${orphan.pid}\n` },
    });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  if (text.includes("Attached image: ")) {
    await handleImagePrompt(id, text);
    return;
  }
  if (text.includes("TOOLS")) {
    await handleToolsPrompt(id);
    return;
  }
  if (text.includes("EDIT_AND_SHELL")) {
    await handleEditAndShellPrompt(id);
    return;
  }
  if (text.includes("MCP_SECURITY_CHECK")) {
    await handleMcpSecurityPrompt(id);
    return;
  }
  if (text.includes("ASK_QUESTION")) {
    await handleAskQuestionPrompt(id);
    return;
  }
  if (text.includes("SUBAGENT")) {
    handleSubagentPrompt(id);
    return;
  }
  if (text.includes("MULTI") || text.includes("RESUME")) {
    handleMultiPrompt(id, text);
    return;
  }
  if (text.includes("TRANSIENT_RETRY")) {
    handleTransientRetryPrompt(id);
    return;
  }
  if (text.includes("NOTIFICATION_COST_TURN_1")) {
    notifyUpdate({
      sessionUpdate: "usage_update",
      used: 50_000,
      size: 1_048_576,
      cost: { amount: 1.0, currency: "USD" },
    });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "DONE_TURN_1\n" },
    });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  if (text.includes("ESTIMATED_TOKENS_TURN_2")) {
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "DONE_TURN_2\n" },
    });
    respond(id, {
      stopReason: "end_turn",
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
      },
    });
    return;
  }

  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: `msg-${id}`,
    content: { type: "text", text: "PHASE0_HELLO" },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: `msg-${id}`,
    content: { type: "text", text: "\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

function handleHangPrompt(id, text) {
  activePromptId = id;
  if (text.includes("TOOL_HANG")) {
    notifyUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "hang-tool-1",
      title: "sleep 60",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "sleep 60" },
    });
  } else {
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "hang-msg-1",
      content: { type: "text", text: "Partial output before interrupt..." },
    });
  }
}

async function handleImagePrompt(id, text) {
  const imageLine = text.split("\n").find((l) => l.startsWith("Attached image: "));
  const imagePath = imageLine ? imageLine.slice("Attached image: ".length).trim() : "/tmp/img.png";
  const perm = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "img-read-1",
      title: `View ${imagePath}`,
      kind: "read",
      status: "pending",
      rawInput: { AbsolutePath: imagePath },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  const allowed = perm?.outcome?.outcome === "selected" && perm.outcome.optionId === "allow";
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: allowed ? "IMAGE_READ_OK\n" : "IMAGE_READ_DENIED\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

async function handleToolsPrompt(id) {
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-read-1",
    title: "View README.md",
    kind: "read",
    status: "completed",
    rawInput: { AbsolutePath: "/workspace/README.md", StartLine: 1, EndLine: 5 },
    rawOutput: { output: "# Readme" },
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-write-1",
    title: "Write out.txt",
    kind: "write",
    status: "completed",
    rawInput: { TargetFile: "/workspace/out.txt", CodeContent: "hello" },
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-shell-1",
    title: "printf PHASE0_SHELL",
    kind: "execute",
    status: "pending",
    rawInput: { CommandLine: "printf PHASE0_SHELL" },
  });
  const perm = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "call-shell-1",
      title: "printf PHASE0_SHELL",
      kind: "execute",
      status: "pending",
      rawInput: { CommandLine: "printf PHASE0_SHELL" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  const allowed = perm?.outcome?.outcome === "selected" && perm.outcome.optionId === "allow";
  notifyUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-shell-1",
    status: allowed ? "completed" : "failed",
    rawOutput: { output: allowed ? "PHASE0_SHELL" : "Command denied by user" },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: allowed ? "TOOLS_ALLOWED\n" : "TOOLS_DENIED\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

async function handleEditAndShellPrompt(id) {
  const editPerm = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "call-edit-1",
      title: "Edit app.ts",
      kind: "edit",
      status: "pending",
      rawInput: {
        TargetFile: "/workspace/app.ts",
        TargetContent: "const a = 1;",
        ReplacementContent: "const a = 2;",
      },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  const editAllowed =
    editPerm?.outcome?.outcome === "selected" && editPerm.outcome.optionId === "allow";
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-edit-1",
    title: "Edit app.ts",
    kind: "edit",
    status: editAllowed ? "completed" : "failed",
    rawInput: {
      TargetFile: "/workspace/app.ts",
      TargetContent: "const a = 1;",
      ReplacementContent: "const a = 2;",
    },
  });

  const shellPerm = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "call-shell-2",
      title: "npm test",
      kind: "execute",
      status: "pending",
      rawInput: { CommandLine: "npm test" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  const shellAllowed =
    shellPerm?.outcome?.outcome === "selected" && shellPerm.outcome.optionId === "allow";
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-shell-2",
    title: "npm test",
    kind: "execute",
    status: shellAllowed ? "completed" : "failed",
    rawInput: { CommandLine: "npm test" },
  });
  respond(id, { stopReason: "end_turn" });
}

async function handleMcpSecurityPrompt(id) {
  const preapprovedPerm = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "mcp-safe-1",
      name: "mcp__docs__lookup",
      title: "Lookup docs",
      kind: "other",
      status: "pending",
      rawInput: { query: "routing" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  const preapprovedAllowed =
    preapprovedPerm?.outcome?.outcome === "selected" &&
    preapprovedPerm.outcome.optionId === "allow";

  const dangerPerm = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "mcp-danger-1",
      name: "mcp__db__execute",
      title: "Execute SQL",
      kind: "search",
      status: "pending",
      rawInput: { query: "DELETE FROM users" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  const dangerAllowed =
    dangerPerm?.outcome?.outcome === "selected" && dangerPerm.outcome.optionId === "allow";

  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `MCP_RESULT:preapproved=${preapprovedAllowed},danger=${dangerAllowed}\n`,
    },
  });
  respond(id, { stopReason: "end_turn" });
}

async function handleAskQuestionPrompt(id) {
  const answer = await requestClient("elicitation/create", {
    sessionId,
    mode: "form",
    message: "The agent has a question.",
    requestedSchema: {
      type: "object",
      properties: {
        q0: {
          type: "string",
          description: "Which UI library should we use?",
          enum: ["React", "Vue", "Other"],
        },
        q0_other: {
          type: "string",
          description: "Optional free-form answer to: Which UI library should we use?",
        },
        q1: {
          type: "array",
          title: "Targets",
          description: "Select target platforms",
          items: {
            type: "string",
            enum: ["Web", "Desktop", "Mobile", "Other"],
          },
        },
        q1_other: {
          type: "string",
        },
      },
      required: ["q0"],
    },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `QUESTION_RESULT:${JSON.stringify(answer)}\n`,
    },
  });
  respond(id, { stopReason: "end_turn" });
}

function handleSubagentPrompt(id) {
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-subagent-1",
    title: "Invoke research subagent",
    kind: "other",
    status: "completed",
    rawInput: {
      TypeName: "research",
      Role: "Codebase Researcher",
      Prompt: "Inspect architecture",
    },
    rawOutput: {
      conversationIds: ["b6f02329-7415-49a7-a9a9-1cd09e898d26"],
    },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "SUBAGENT_DONE\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

function handleMultiPrompt(id, text) {
  let tokens = 11604;
  if (text.includes("RESUME")) {
    tokens = 11815;
  } else if (multiTurnCount++ === 0) {
    tokens = 11263;
  }
  notifyUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Thinking through the request..." },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "MULTI_OK\n" },
  });
  notifyUpdate({
    sessionUpdate: "usage_update",
    used: tokens + 120,
    size: 1_048_576,
    inputTokens: tokens,
    outputTokens: 120,
  });
  respond(id, {
    stopReason: "end_turn",
    usage: {
      inputTokens: tokens,
      outputTokens: 120,
    },
  });
}

function handleTransientRetryPrompt(id) {
  process.stderr.write("API error (attempt 1/3): 503 Service Unavailable\nRetries remaining: 3\n");
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "RECOVERED_AFTER_RETRY\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

function tierMeta() {
  const tierName = process.env.AGY_TEST_TIER ?? "Google AI Pro";
  return tierName ? { antigravity: { tier: { name: tierName, id: "g1-pro-tier" } } } : undefined;
}

function handleSessionList(id, params) {
  let cwd = process.env.AGY_TEST_LIST_CWD || params?.cwd || "/workspace/project-a";
  try {
    cwd = realpathSync(cwd);
  } catch {
    // Keep non-existent test paths as-is.
  }
  if (!params?.cursor) {
    respond(id, {
      sessions: [
        {
          sessionId: "conv-alpha-1",
          cwd,
          title: "Refactor auth middleware",
          updatedAt: "2026-11-03T18:00:00.000Z",
        },
        {
          sessionId: "conv-other-cwd",
          cwd: "/workspace/other-repo",
          title: "Unrelated workspace task",
          updatedAt: "2026-11-03T17:00:00.000Z",
        },
      ],
      nextCursor: "page-2",
    });
    return;
  }
  respond(id, {
    sessions: [
      {
        sessionId: "conv-alpha-1",
        cwd,
        title: "Refactor auth middleware",
        updatedAt: "2026-11-03T18:00:00.000Z",
      },
      {
        sessionId: "conv-beta-2",
        cwd,
        title: "Add usage quota reporting",
        updatedAt: "2026-11-03T16:30:00.000Z",
      },
    ],
  });
}

async function handleSessionLoad(id, params) {
  sessionId = params.sessionId || DEFAULT_SESSION_ID;
  if (process.env.AGY_TEST_LOAD_MODEL) {
    currentModel = process.env.AGY_TEST_LOAD_MODEL;
  }
  if (process.env.AGY_TEST_LOAD_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.AGY_TEST_LOAD_DELAY_MS)));
  }
  const extraChunks = Number(process.env.AGY_TEST_REPLAY_CHUNKS || "0");
  for (let i = 0; i < extraChunks; i += 1) {
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: `bulk-${Math.floor(i / 5)}`,
      content: { type: "text", text: `c${i % 5}` },
    });
  }
  notifyUpdate({
    sessionUpdate: "user_message_chunk",
    messageId: "replay-u1",
    content: { type: "text", text: "REPLAYED_USER" },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "replay-a1",
    content: { type: "text", text: "REPLAYED_ASSISTANT" },
  });
  if (process.env.AGY_TEST_REPLAY_COST) {
    notifyUpdate({
      sessionUpdate: "usage_update",
      used: 60_000,
      size: 1_048_576,
      cost: { amount: Number(process.env.AGY_TEST_REPLAY_COST), currency: "USD" },
    });
  }
  notifyUpdate({
    sessionUpdate: "plan",
    entries: [
      { content: "Inspect plugin SDK", status: "completed" },
      { content: "Ship ACP provider", status: "in_progress" },
    ],
  });
  respond(id, {
    sessionId,
    models: {
      currentModelId: currentModel,
    },
    _meta: tierMeta(),
  });
  notifyUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "plan", description: "Plan a task before execution", input: { hint: "<task>" } },
      { name: "compact", description: "Compact conversation context" },
    ],
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ rpc: msg });

  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pendingClientRequests.get(msg.id);
    if (resolve) {
      pendingClientRequests.delete(msg.id);
      resolve(msg.result);
    }
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            resume: {},
            close: {},
            load: {},
            list: {},
            additionalDirectories: {},
          },
        },
        agentInfo: { name: "antigravity", title: "Antigravity", version: "1.4.12" },
      });
      return;
    case "session/list":
      handleSessionList(id, params);
      return;
    case "session/new":
      sessionId = DEFAULT_SESSION_ID;
      respond(id, {
        sessionId,
        models: { currentModelId: currentModel },
        _meta: tierMeta(),
      });
      notifyUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Plan a task before execution", input: { hint: "<task>" } },
          { name: "compact", description: "Compact conversation context" },
        ],
      });
      if (process.env.AGY_TEST_CLOSE_STDIN_AFTER_NEW === "yes") {
        setInterval(() => {}, 1000);
        try {
          closeSync(0);
        } catch {
          // ignore
        }
      }
      return;
    case "session/load":
      await handleSessionLoad(id, params);
      return;
    case "session/set_model":
      if (Number(process.env.AGY_TEST_SET_MODEL_DELAY_MS) > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Number(process.env.AGY_TEST_SET_MODEL_DELAY_MS)),
        );
      }
      if (failSetModelOnce || (failSetModelTarget && params.modelId === failSetModelTarget)) {
        failSetModelOnce = false;
        failSetModelTarget = undefined;
        respondError(id, -32603, "Transient model switch error");
        return;
      }
      currentModel = params.modelId;
      respond(id, { models: { currentModelId: currentModel } });
      return;
    case "session/cancel":
      if (process.env.AGY_TEST_IGNORE_CANCEL === "yes") return;
      if (activePromptId !== null) {
        const cancelledId = activePromptId;
        activePromptId = null;
        respond(cancelledId, { stopReason: "cancelled" });
      }
      return;
    case "session/prompt":
      await handlePrompt(id, params);
      return;
  }
});

process.on("SIGINT", () => {
  record({ signal: "SIGINT" });
  if (process.env.AGY_TEST_IGNORE_SIGNALS === "yes") return;
  process.exit(1);
});

process.on("SIGTERM", () => {
  record({ signal: "SIGTERM" });
  if (process.env.AGY_TEST_IGNORE_SIGNALS !== "yes") process.exit(0);
});

lines.on("close", () => {
  if (
    process.env.AGY_TEST_IGNORE_SIGNALS !== "yes" &&
    process.env.AGY_TEST_CLOSE_STDIN_AFTER_NEW !== "yes"
  ) {
    process.exit(0);
  }
});
