import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
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

const promptFlagIdx = args.indexOf("-p");
if (promptFlagIdx !== -1) {
  const slashCmd = args[promptFlagIdx + 1] || "";
  if (slashCmd === "/usage") {
    const mode = process.env.AGY_TEST_USAGE || "json";
    if (mode === "auth") {
      process.stdout.write(
        JSON.stringify({
          conversation_id: "",
          status: "ERROR",
          response: "",
          error: "UNAUTHENTICATED: request returned 401 authentication required",
        }) + "\n",
      );
      process.exit(0);
    }
    if (mode === "forbidden") {
      process.stderr.write('AGY_ERROR: {"short_error":"403 PERMISSION_DENIED"}\n');
      process.exit(1);
    }
    if (mode === "empty") {
      process.stdout.write(
        JSON.stringify({
          conversation_id: "",
          status: "SUCCESS",
          response: "",
          command: { name: "usage", data: { groups: [] } },
        }) + "\n",
      );
      process.exit(0);
    }
    if (mode === "tsv") {
      process.stdout.write(
        "Gemini Models\tWeekly Limit Remaining\t73%\t2026-11-14T05:30:13Z\n" +
          "Gemini Models\tFive Hour Limit Remaining\t68%\t2026-11-11T07:04:06Z\n" +
          "Claude and GPT models\tWeekly Limit Remaining\t86%\t2026-11-15T08:19:51Z\n" +
          "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-11T11:41:37Z\n",
      );
      process.exit(0);
    }
    process.stdout.write(
      JSON.stringify({
        conversation_id: "",
        status: "SUCCESS",
        response:
          "Gemini Models\tWeekly Limit Remaining\t73%\t2026-11-14T05:30:13Z\n" +
          "Gemini Models\tFive Hour Limit Remaining\t68%\t2026-11-11T07:04:06Z\n",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 0.73,
                    reset_time: "2026-11-14T05:30:13Z",
                  },
                  {
                    id: "gemini-5h",
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    remaining_fraction: 0.68,
                    reset_time: "2026-11-11T07:04:06Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  {
                    id: "3p-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 0.86,
                    reset_time: "2026-11-15T08:19:51Z",
                  },
                  {
                    id: "3p-5h",
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    remaining_fraction: 1,
                    reset_time: "2026-11-11T11:41:37Z",
                  },
                ],
              },
            ],
          },
        },
      }) + "\n",
    );
    process.exit(0);
  }
  if (slashCmd === "/credits") {
    const mode = process.env.AGY_TEST_CREDITS || "json";
    if (mode === "zero") {
      process.stdout.write(
        JSON.stringify({
          conversation_id: "",
          status: "SUCCESS",
          response: "Remaining credits\t0\n",
          command: { name: "credits", data: { remaining_credits: 0 } },
        }) + "\n",
      );
      process.exit(0);
    }
    if (mode === "tsv") {
      process.stdout.write("Remaining credits\t250\n");
      process.exit(0);
    }
    process.stdout.write(
      JSON.stringify({
        conversation_id: "",
        status: "SUCCESS",
        response: "Remaining credits\t420\n",
        command: { name: "credits", data: { remaining_credits: 420 } },
      }) + "\n",
    );
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
const pendingClientRequests = new Map();
const stepCounters = new Map();

function appendTranscriptStep(convId, step) {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (!dataDir) return;
  const logDir = path.join(dataDir, "brain", convId, ".system_generated", "logs");
  mkdirSync(logDir, { recursive: true });
  const nextIndex = step.step_index ?? stepCounters.get(convId) ?? 0;
  stepCounters.set(convId, nextIndex + 1);
  const fullStep = {
    step_index: nextIndex,
    created_at: new Date().toISOString(),
    status: "DONE",
    ...step,
  };
  appendFileSync(path.join(logDir, "transcript.jsonl"), `${JSON.stringify(fullStep)}\n`);
}

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

const PROMPT_ROUTES = [
  ["TOOL_HANG", (id, text) => handleHangPrompt(id, text)],
  ["HANG", (id, text) => handleHangPrompt(id, text)],
  ["Attached image: ", (id, text) => handleImagePrompt(id, text)],
  ["TOOLS", (id) => handleToolsPrompt(id)],
  ["EDIT_AND_SHELL", (id) => handleEditAndShellPrompt(id)],
  ["ASK_QUESTION", (id) => handleAskQuestionPrompt(id)],
  ["PROMPT_CACHED_USAGE", (id) => handlePromptCachedUsage(id)],
  ["BG_RUN_COMMAND_WAKEUP", (id) => handleBgRunCommandWakeup(id)],
  ["BG_WAKEUP_SHELL_TOOL", (id) => handleBgWakeupShellTool(id)],
  ["FOLLOWUP_AFTER_WAKEUP", (id, text) => handleFollowupAfterWakeup(id, text)],
  ["BG_SCHEDULE_ONESHOT_WAKEUP", (id) => handleBgScheduleOneshotWakeup(id)],
  ["BG_SCHEDULE_DAEMON_WAKEUP", (id) => handleBgScheduleDaemonWakeup(id)],
  ["KILL_DAEMON_SCHEDULE", (id) => handleKillDaemonSchedule(id)],
  ["IN_TURN_WAKEUP_SPLIT", (id) => handleInTurnWakeupSplit(id)],
  ["ACP_UNSOLICITED_WAKEUP", (id) => handleAcpUnsolicitedWakeup(id)],
  ["SUBAGENT_LIVE_AND_WAKEUP", (id) => handleSubagentLiveAndWakeup(id)],
  ["SUBAGENT_SEND_MESSAGE", (id) => handleSubagentSendMessage(id)],
  ["SUBAGENT_KILL", (id) => handleSubagentKill(id)],
  ["SUBAGENT", (id) => handleSubagentPrompt(id)],
  ["MULTI", (id, text) => handleMultiPrompt(id, text)],
  ["RESUME", (id, text) => handleMultiPrompt(id, text)],
  ["TRANSIENT_RETRY", (id) => handleTransientRetryPrompt(id)],
  ["MCP_QUERY_TOOL", (id) => handleMcpQueryToolPrompt(id)],
];

async function handlePrompt(id, params) {
  const text = (params.prompt || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  record({ input: { message: { content: text } } });

  if (!text.includes("FOLLOWUP_AFTER_WAKEUP") && !text.trimStart().startsWith("/")) {
    notifyUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });
  }

  for (const [marker, handler] of PROMPT_ROUTES) {
    if (text.includes(marker)) {
      await handler(id, text);
      return;
    }
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

const LIVE_SUBAGENT_C1 = "11111111-2222-4333-8444-555555555555";
const LIVE_SUBAGENT_C2 = "22222222-3333-4444-8555-666666666666";
const LIVE_SUBAGENT_C3 = "33333333-4444-4555-8666-777777777777";

function handlePromptCachedUsage(id) {
  appendTranscriptStep(sessionId, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nPROMPT_CACHED_USAGE\n</USER_REQUEST>",
  });
  appendTranscriptStep(sessionId, {
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "CACHED_USAGE_OK\n",
    input_tokens: 15000,
    cache_read_tokens: 8000,
    output_tokens: 300,
    thinking_tokens: 100,
    total_tokens: 23400,
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "CACHED_USAGE_OK\n" },
  });
  respond(id, {
    stopReason: "end_turn",
    usage: {
      inputTokens: 15000,
      outputTokens: 300,
      cachedReadTokens: 8000,
      thoughtTokens: 100,
      totalTokens: 23400,
    },
  });
}

function handleBgRunCommandWakeup(id) {
  const taskId = `${sessionId}/task-1`;
  appendTranscriptStep(sessionId, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nBG_RUN_COMMAND_WAKEUP\n</USER_REQUEST>",
  });
  appendTranscriptStep(sessionId, {
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "Starting async build...",
    tool_calls: [
      {
        id: "bg-cmd-1",
        name: "run_command",
        args: {
          CommandLine: JSON.stringify("sleep 2 && echo done"),
          WaitMsBeforeAsync: "500",
        },
      },
    ],
  });
  appendTranscriptStep(sessionId, {
    source: "SYSTEM",
    type: "GENERIC",
    status: "RUNNING",
    content: `Command started.\nTool is running as a background task with task id: ${taskId}\n`,
  });

  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "bg-cmd-1",
    title: "sleep 2 && echo done",
    kind: "execute",
    status: "completed",
    rawInput: { CommandLine: "sleep 2 && echo done", WaitMsBeforeAsync: 500 },
    rawOutput: {
      output: `Command started.\nTool is running as a background task with task id: ${taskId}\n`,
    },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Started background command.\n" },
  });
  respond(id, { stopReason: "end_turn" });

  setTimeout(() => {
    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:00:01Z sender=${taskId} priority=HIGH content=Background task ${taskId} finished with exit code 0: done\n</SYSTEM_MESSAGE>`,
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      thinking: "Task-1 finished cleanly.",
      content: "BG_COMMAND_WAKEUP_COMPLETE",
      input_tokens: 12000,
      cache_read_tokens: 4000,
      output_tokens: 80,
    });
  }, 180);
}

function handleBgWakeupShellTool(id) {
  appendTranscriptStep(sessionId, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nBG_WAKEUP_SHELL_TOOL\n</USER_REQUEST>",
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "sched-shell-1",
    title: "schedule",
    kind: "other",
    status: "completed",
    rawInput: { DurationSeconds: 180, Prompt: "Run date in wakeup" },
    rawOutput: { output: "Scheduled 180s timer" },
  });
  respond(id, { stopReason: "end_turn" });

  setTimeout(() => {
    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content:
        "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T17:01:50Z sender=scheduler priority=HIGH content=Run date in wakeup\n</SYSTEM_MESSAGE>",
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      thinking: "Timer fired; checking wall-clock time.",
      tool_calls: [
        {
          id: "wakeup-shell-1",
          name: "run_command",
          args: {
            CommandLine: JSON.stringify("date '+%Y-%m-%d %H:%M:%S'"),
            WaitMsBeforeAsync: "5000",
          },
        },
      ],
    });
    // Real agy closes its ACP conversation stream goroutine when session/prompt exits:
    // without --dangerously-skip-permissions, run_command stalls in WAITING_FOR_USER.
    if (!args.includes("--dangerously-skip-permissions")) {
      return;
    }
    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "GENERIC",
      status: "DONE",
      content: "Command exited with code 0.\n\nCommand output:\n2026-11-11 17:01:50\n",
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "WAKEUP_SHELL_TOOL_OK: 2026-11-11 17:01:50",
    });
  }, 160);
}

function handleFollowupAfterWakeup(id, text) {
  // Simulate real agy ACP stream catch-up: when the next foreground session/prompt starts,
  // agy streams all post-turn wakeup steps accumulated since the previous prompt BEFORE
  // emitting the new turn's user_message_chunk.
  notifyUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Timer fired; checking wall-clock time." },
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "wakeup-shell-1",
    title: "date '+%Y-%m-%d %H:%M:%S'",
    kind: "execute",
    status: "completed",
    rawInput: { CommandLine: "date '+%Y-%m-%d %H:%M:%S'" },
    rawOutput: { output: "2026-11-11 17:01:50\n" },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "stale-wakeup-msg",
    content: { type: "text", text: "WAKEUP_SHELL_TOOL_OK: 2026-11-11 17:01:50" },
  });

  // Now agy reaches the new USER_INPUT step and streams the fresh turn response:
  notifyUpdate({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "fresh-followup-msg",
    content: { type: "text", text: "FRESH_FOLLOWUP_RESPONSE" },
  });
  respond(id, { stopReason: "end_turn" });
}

function handleBgScheduleOneshotWakeup(id) {
  appendTranscriptStep(sessionId, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nBG_SCHEDULE_ONESHOT_WAKEUP\n</USER_REQUEST>",
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "sched-oneshot-1",
    title: "schedule",
    kind: "other",
    status: "completed",
    rawInput: { DurationSeconds: 1, Prompt: "Check build status" },
    rawOutput: { output: "Scheduled one-shot timer" },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Scheduled timer.\n" },
  });
  respond(id, { stopReason: "end_turn" });

  setTimeout(() => {
    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content:
        "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:00:02Z sender=scheduler priority=HIGH content=Check build status\n</SYSTEM_MESSAGE>",
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "ONESHOT_TIMER_FIRED",
    });
  }, 180);
}

function handleBgScheduleDaemonWakeup(id) {
  const cronTaskId = `${sessionId}/task-cron-1`;
  appendTranscriptStep(sessionId, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nBG_SCHEDULE_DAEMON_WAKEUP\n</USER_REQUEST>",
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "sched-daemon-1",
    title: "schedule",
    kind: "other",
    status: "completed",
    rawInput: { CronExpression: "*/1 * * * *", IsDaemon: true, Prompt: "Daemon heartbeat" },
    rawOutput: { taskId: cronTaskId },
  });
  respond(id, { stopReason: "end_turn" });

  setTimeout(() => {
    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:01:00Z sender=${cronTaskId} priority=HIGH content=Daemon heartbeat\n</SYSTEM_MESSAGE>`,
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "DAEMON_CRON_TICK_1",
    });
  }, 160);

  setTimeout(() => {
    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:02:00Z sender=${cronTaskId} priority=HIGH content=Daemon heartbeat\n</SYSTEM_MESSAGE>`,
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "DAEMON_CRON_TICK_2",
    });
  }, 620);
}

function handleKillDaemonSchedule(id) {
  const cronTaskId = `${sessionId}/task-cron-1`;
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "manage-kill-cron-1",
    title: "manage_task",
    kind: "other",
    status: "completed",
    rawInput: { Action: "kill", TaskId: cronTaskId },
    rawOutput: { output: `Killed ${cronTaskId}` },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Stopped daemon cron.\n" },
  });
  respond(id, { stopReason: "end_turn" });
}

async function handleInTurnWakeupSplit(id) {
  const taskId = `${sessionId}/task-inturn`;
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "shared-msg",
    content: { type: "text", text: "BEFORE_WAKEUP" },
  });
  appendTranscriptStep(sessionId, {
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:03:00Z sender=${taskId} priority=HIGH content=Task finished\n</SYSTEM_MESSAGE>`,
  });
  await new Promise((resolve) => setTimeout(resolve, 220));
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "shared-msg",
    content: { type: "text", text: "AFTER_WAKEUP" },
  });
  respond(id, { stopReason: "end_turn" });
}

function handleAcpUnsolicitedWakeup(id) {
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "INITIAL_TURN_DONE\n" },
  });
  respond(id, { stopReason: "end_turn" });

  setTimeout(() => {
    notifyUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Post-turn ACP thought..." },
    });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ACP_WAKEUP_HELLO" },
    });
  }, 150);
}

function handleSubagentLiveAndWakeup(id) {
  appendTranscriptStep(LIVE_SUBAGENT_C2, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nCheck Ed25519\n</USER_REQUEST>",
  });
  appendTranscriptStep(LIVE_SUBAGENT_C2, {
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "Ed25519 verified",
  });

  appendTranscriptStep(LIVE_SUBAGENT_C1, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nAudit security\n</USER_REQUEST>",
  });
  appendTranscriptStep(LIVE_SUBAGENT_C1, {
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    thinking: "Delegating crypto check to nested subagent",
    tool_calls: [
      {
        id: "c1-nested-sub",
        name: "invoke_subagent",
        args: {
          TypeName: JSON.stringify("research"),
          Role: JSON.stringify("Crypto Auditor"),
          Prompt: JSON.stringify("Check Ed25519"),
        },
      },
    ],
  });
  appendTranscriptStep(LIVE_SUBAGENT_C1, {
    source: "SYSTEM",
    type: "GENERIC",
    content: JSON.stringify({ conversationIds: [LIVE_SUBAGENT_C2] }),
  });
  appendTranscriptStep(LIVE_SUBAGENT_C1, {
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:04:00Z sender=${LIVE_SUBAGENT_C2} priority=HIGH content=Ed25519 verified\n</SYSTEM_MESSAGE>`,
  });

  appendTranscriptStep(sessionId, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nSUBAGENT_LIVE_AND_WAKEUP\n</USER_REQUEST>",
  });
  appendTranscriptStep(sessionId, {
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "Launched security lead subagent.",
    tool_calls: [
      {
        id: "call-live-sub-1",
        name: "invoke_subagent",
        args: {
          TypeName: JSON.stringify("self"),
          Role: JSON.stringify("Security Lead"),
          Prompt: JSON.stringify("Audit security"),
        },
      },
    ],
  });
  appendTranscriptStep(sessionId, {
    source: "SYSTEM",
    type: "GENERIC",
    content: JSON.stringify({ conversationIds: [LIVE_SUBAGENT_C1] }),
  });

  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-live-sub-1",
    title: "invoke_subagent",
    kind: "other",
    status: "completed",
    rawInput: {
      TypeName: "self",
      Role: "Security Lead",
      Prompt: "Audit security",
    },
    rawOutput: {
      conversationIds: [LIVE_SUBAGENT_C1],
    },
  });
  notifyUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Waiting on Security Lead.\n" },
  });
  respond(id, { stopReason: "end_turn" });

  setTimeout(async () => {
    const perm = await requestClient("session/request_permission", {
      sessionId: LIVE_SUBAGENT_C1,
      toolCall: {
        toolCallId: "c1-cmd-1",
        title: "npm audit",
        kind: "execute",
        status: "pending",
        rawInput: { CommandLine: "npm audit" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const allowed = perm?.outcome?.outcome === "selected" && perm.outcome.optionId === "allow";
    appendTranscriptStep(LIVE_SUBAGENT_C1, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          id: "c1-cmd-1",
          name: "run_command",
          args: { CommandLine: JSON.stringify("npm audit") },
        },
      ],
    });
    appendTranscriptStep(LIVE_SUBAGENT_C1, {
      source: "SYSTEM",
      type: "GENERIC",
      status: allowed ? "DONE" : "ERROR",
      content: allowed ? "found 0 vulnerabilities" : "Command denied",
    });
    appendTranscriptStep(LIVE_SUBAGENT_C1, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: allowed ? "Security audit passed" : "Security audit blocked",
    });

    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:04:05Z sender=${LIVE_SUBAGENT_C1} priority=HIGH content=Security audit passed\n</SYSTEM_MESSAGE>`,
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "PARENT_RECEIVED_SUBAGENT_RESULT",
    });
  }, 180);
}

function handleSubagentSendMessage(id) {
  appendTranscriptStep(sessionId, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nSUBAGENT_SEND_MESSAGE\n</USER_REQUEST>",
  });
  appendTranscriptStep(sessionId, {
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        id: "call-send-msg-1",
        name: "send_message",
        args: {
          Recipient: JSON.stringify(LIVE_SUBAGENT_C1),
          Message: JSON.stringify("Also check dependencies"),
        },
      },
    ],
  });
  appendTranscriptStep(sessionId, {
    source: "SYSTEM",
    type: "GENERIC",
    content: "Message delivered",
  });

  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-send-msg-1",
    title: "send_message",
    kind: "other",
    status: "completed",
    rawInput: {
      Recipient: LIVE_SUBAGENT_C1,
      Message: "Also check dependencies",
    },
    rawOutput: { output: "Message delivered" },
  });
  respond(id, { stopReason: "end_turn" });

  setTimeout(() => {
    appendTranscriptStep(LIVE_SUBAGENT_C1, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content:
        "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:04:10Z sender=parent priority=HIGH content=Also check dependencies\n</SYSTEM_MESSAGE>",
    });
    appendTranscriptStep(LIVE_SUBAGENT_C1, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "Dependencies clean",
    });
    appendTranscriptStep(sessionId, {
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-11T06:04:12Z sender=${LIVE_SUBAGENT_C1} priority=HIGH content=Dependencies clean\n</SYSTEM_MESSAGE>`,
    });
    appendTranscriptStep(sessionId, {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "PARENT_FOLLOWUP_DONE",
    });
  }, 160);
}

function handleSubagentKill(id) {
  appendTranscriptStep(LIVE_SUBAGENT_C3, {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nLong task\n</USER_REQUEST>",
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-sub-kill-spawn",
    title: "invoke_subagent",
    kind: "other",
    status: "completed",
    rawInput: {
      TypeName: "research",
      Role: "Slow Worker",
      Prompt: "Long task",
    },
    rawOutput: { conversationIds: [LIVE_SUBAGENT_C3] },
  });
  notifyUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-sub-kill-exec",
    title: "manage_subagents",
    kind: "other",
    status: "completed",
    rawInput: {
      Action: "kill",
      ConversationIds: [LIVE_SUBAGENT_C3],
    },
    rawOutput: { output: "Killed subagent" },
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
    const tierName = process.env.AGY_TEST_TIER || "Google AI Ultra";
    respond(id, {
      sessionId,
      models: {
        currentModelId: currentModel,
      },
      _meta: {
        antigravity: {
          tier: { id: "g1-ultra-tier", name: tierName },
        },
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
    const tierName = process.env.AGY_TEST_TIER || "Google AI Ultra";
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
      _meta: {
        antigravity: {
          tier: { id: "g1-ultra-tier", name: tierName },
        },
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
      send({
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

  if (method === "session/set_mode") {
    respond(id, {});
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
