import { readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = process.env.AGY_TEST_LOG;
function record(value) {
  if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
}
record({ args, pid: process.pid, env: process.env.AGY_SESSION_VALUE });

function fixture(name, stream = "stdout") {
  return readFileSync(new URL(`./fixtures/${name}.${stream}.ndjson`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).data);
}

if (args.includes("--version")) {
  process.stdout.write(`${process.env.AGY_TEST_VERSION || "1.4.1"}\n`);
  process.exit(0);
}

if (args.includes("models")) {
  if (process.env.AGY_TEST_AUTH === "missing") {
    process.stderr.write(fixture("models-unauthenticated", "stderr").join("\n"));
    process.exit(1);
  }
  process.stdout.write(fixture("models-api-key").join("\n") + "\n");
  process.exit(0);
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
const pendingClientRequests = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
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
  record({ input: { message: { content: text } } });

  if (text.includes("HANG") || text.includes("TOOL_HANG")) {
    handleHangPrompt(id, text);
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
  if (text.includes("MCP_QUERY_TOOL")) {
    await handleMcpQueryToolPrompt(id);
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
    inputTokens: tokens,
    outputTokens: 120,
  });
  respond(id, { stopReason: "end_turn" });
}

function handleTransientRetryPrompt(id) {
  process.stderr.write("API error (attempt 1/3): 503 Service Unavailable\nRetries remaining: 3\n");
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "RECOVERED_AFTER_RETRY\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

async function handleMcpQueryToolPrompt(id) {
  const perm = await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "call-mcp-query-1",
      title: "mcp__db__query",
      status: "pending",
      rawInput: { query: "DELETE FROM users" },
    },
    options: [
      { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
      { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
      { optionId: "deny_once", name: "Deny", kind: "reject_once" },
    ],
  });
  const allowed =
    perm?.outcome?.outcome === "selected" && perm.outcome.optionId.startsWith("allow");
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: allowed ? "MCP_QUERY_ALLOWED\n" : "MCP_QUERY_DENIED\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

let failedSetModelOnce = false;

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

  if (method === "initialize") {
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
      agentInfo: { name: "antigravity", title: "Antigravity", version: "1.4.1" },
    });
    return;
  }

  if (method === "session/new") {
    sessionId = DEFAULT_SESSION_ID;
    respond(id, {
      sessionId,
      models: {
        currentModelId: currentModel,
      },
    });
    notifyUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "plan", description: "Plan a task before execution", input: { hint: "<task>" } },
        { name: "compact", description: "Compact conversation context" },
      ],
    });
    return;
  }

  if (method === "session/load") {
    sessionId = params.sessionId || DEFAULT_SESSION_ID;
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
    respond(id, {
      sessionId,
      models: {
        currentModelId: currentModel,
      },
    });
    notifyUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "plan", description: "Plan a task before execution", input: { hint: "<task>" } },
        { name: "compact", description: "Compact conversation context" },
      ],
    });
    return;
  }

  if (method === "session/set_model") {
    if (process.env.AGY_TEST_FAIL_SET_MODEL_ONCE === "yes" && !failedSetModelOnce) {
      failedSetModelOnce = true;
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Model switch temporarily unavailable" },
      });
      return;
    }
    currentModel = params.modelId;
    respond(id, {
      models: {
        currentModelId: currentModel,
      },
    });
    return;
  }

  if (method === "session/cancel") {
    if (process.env.AGY_TEST_IGNORE_CANCEL === "yes") return;
    if (activePromptId !== null) {
      const cancelledId = activePromptId;
      activePromptId = null;
      respond(cancelledId, { stopReason: "cancelled" });
    }
    return;
  }

  if (method === "session/prompt") {
    await handlePrompt(id, params);
  }
});

process.on("SIGINT", () => {
  record({ signal: "SIGINT" });
  if (process.env.AGY_TEST_IGNORE_SIGNALS === "yes") return;
  process.exit(1);
});

process.on("SIGTERM", () => {
  record({ signal: "SIGTERM" });
  if (process.env.AGY_TEST_IGNORE_SIGNALS !== "yes") process.exit(1);
});

lines.on("close", () => {
  if (process.env.AGY_TEST_IGNORE_SIGNALS !== "yes") process.exit(0);
});
