import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const scenario = process.env.MUSE_TEST_SCENARIO || "text-reasoning";
if (process.argv.includes("--version")) {
  if (process.env.MUSE_TEST_VERSION_ERROR) {
    process.stderr.write(process.env.MUSE_TEST_VERSION_ERROR + "\n");
    process.exit(17);
  }
  process.stdout.write(`Muse Code ${process.env.MUSE_TEST_VERSION || "1.4.1"}\n`);
  process.exit(0);
}
if (process.env.MUSE_TEST_STUBBORN) {
  setInterval(() => {}, 1000);
  appendFileSync(
    process.env.MUSE_TEST_REQUESTS,
    JSON.stringify({ event: "stubbornHost", pid: process.pid }) + "\n",
  );
}
const rows = readFixture(scenario);
if (process.env.MUSE_TEST_REQUESTS)
  appendFileSync(
    process.env.MUSE_TEST_REQUESTS,
    JSON.stringify({ event: "hostStarted", args: process.argv.slice(2) }) + "\n",
  );
const catalogRows = readFixture("catalog-controls");
const replacements = new Map();
const counts = new Map();
const receipts = new Set();
const lines = createInterface({ input: process.stdin });
lines.on("line", receive);
function receive(line) {
  const parsed = JSON.parse(line);
  if (parsed.method === "initialize" && process.env.MUSE_TEST_INITIALIZE_DELAY_MS) {
    setTimeout(() => receiveFrame(line), Number(process.env.MUSE_TEST_INITIALIZE_DELAY_MS));
    return;
  }
  receiveFrame(line);
}
function receiveFrame(line) {
  const frame = JSON.parse(line);
  if (process.env.MUSE_TEST_REQUESTS)
    appendFileSync(process.env.MUSE_TEST_REQUESTS, JSON.stringify(frame) + "\n");
  if (frame.result) {
    receipts.delete(frame.id);
    return;
  }
  if (controlResponse(frame)) return;
  if (queuedResponse(frame)) return;
  const candidates = rows.filter((row) => row.dir === "out" && row.msg.method === frame.method);
  const count = counts.get(frame.method) || 0;
  counts.set(frame.method, count + 1);
  if (retryResponse(frame, count)) return;
  const request = candidates[count];
  if (!request)
    return rpcError(
      frame,
      -32601,
      "unknownMethod",
      `No fixture request for ${frame.method} #${count}`,
    );
  const recorded = request.msg;
  validateCommand(frame, recorded);
  const response = rows.find(
    (row) => row.dir === "in" && row.msg.id === recorded.id && !row.msg.method,
  );
  if (!response) throw new Error(`Fixture response absent: ${frame.method}`);
  const position = rows.indexOf(request);
  let end = position + 1;
  while (end < rows.length && !(rows[end].dir === "out" && rows[end].msg.method)) end++;
  const messages = rows.slice(position + 1, end).filter((row) => row.dir === "in");
  if (!messages.includes(response)) messages.unshift(response);
  if (process.env.MUSE_TEST_ACK_LAST && frame.method === "turn/start") {
    const terminalFirst = messages.filter((row) => row !== response);
    for (const row of terminalFirst) emitFixtureMessage(row.msg, recorded, frame);
    setTimeout(() => emitFixtureMessage(response.msg, recorded, frame), 50);
  } else for (const row of messages) emitFixtureMessage(row.msg, recorded, frame);
}
function controlResponse(frame) {
  if (frame.method === "session/resume" && process.env.MUSE_TEST_HISTORY) {
    const result = responseFor(readFixture("resume-without-cursor"), "session/resume");
    result.session.sessionId = frame.params.sessionId;
    result.history = frame.params.cursor
      ? { mode: "none", noneReason: "cursorSuffix", items: null, snapshot: null }
      : {
          mode: "inline",
          items: readFileSync(process.env.MUSE_TEST_HISTORY, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
          snapshot: null,
        };
    respond(frame, result);
    return true;
  }
  if (frame.method === "initialized") return true;
  if (frame.method === "initialize" && process.env.MUSE_TEST_EXIT) {
    process.stderr.write("diagnostic tail, not protocol\n");
    process.exit(Number(process.env.MUSE_TEST_EXIT));
  }
  if (frame.method === "initialize" && process.env.MUSE_TEST_NULL_ERROR_ID) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Cannot recover request id", data: { kind: "parseError" } },
    });
    return true;
  }
  if (process.env.MUSE_TEST_HANG === frame.method) return true;
  if (frame.method === "session/setReasoningEffort") {
    respond(frame, { status: "accepted", commandId: frame.params.commandId });
    return true;
  }
  if (frame.method === "account/read") {
    respond(frame, { credentialRequired: true, state: process.env.MUSE_TEST_ACCOUNT || "envKey" });
    return true;
  }
  if (parityResponse(frame)) return true;
  if (frame.method === "model/list") {
    const result = responseFor(catalogRows, "model/list");
    if (process.env.MUSE_TEST_MODELS) result.models = JSON.parse(process.env.MUSE_TEST_MODELS);
    respond(frame, result);
    return true;
  }
  if (frame.method === "session/resume" && process.env.MUSE_TEST_GONE) {
    rpcError(frame, -32020, "sessionNotFound", "missing");
    return true;
  }
  return false;
}
function parityResponse(frame) {
  if (historyReadResponse(frame)) return true;
  if (workflowResponse(frame)) return true;
  if (frame.method === "view/page") return historyPageResponse(frame);
  if (frame.method === "session/read") {
    const result = responseFor(readFixture("phase3-child-read"), "session/read");
    result.session.sessionId = frame.params.sessionId;
    respond(frame, result);
    return true;
  }
  if (frame.method === "usage/read") {
    const result = process.env.MUSE_TEST_USAGE
      ? JSON.parse(process.env.MUSE_TEST_USAGE)
      : responseFor(catalogRows, "usage/read");
    respond(frame, result);
    return true;
  }
  if (frame.method === "session/list") {
    const result = responseFor(catalogRows, "session/list");
    result.nextCursor = null;
    if (process.env.MUSE_TEST_NULL_MODEL) {
      for (const session of result.sessions) session.modelId = null;
    }
    respond(frame, result);
    return true;
  }
  if (frame.method === "userInput/cancel" && scenario !== "phase3-cancel") {
    respond(frame, {
      status: "accepted",
      commandId: frame.params.commandId,
      userInputId: frame.params.userInputId,
    });
    send({
      jsonrpc: "2.0",
      method: "userInput/settled",
      params: {
        sessionId: frame.params.sessionId,
        userInputId: frame.params.userInputId,
        outcome: "cancelled",
      },
    });
    return true;
  }
  if (frame.method === "session/compact" && process.env.MUSE_TEST_COMPACT) {
    respond(frame, { status: "accepted", commandId: frame.params.commandId });
    for (const [revision, status] of [
      [1, "inProgress"],
      [2, "completed"],
    ])
      send({
        jsonrpc: "2.0",
        method: revision === 1 ? "item/started" : "item/completed",
        params: {
          sessionId: frame.params.sessionId,
          item: { itemId: "fixture-compaction", revision, kind: "compaction", status },
        },
      });
    return true;
  }
  if (skillResponse(frame)) return true;
  return false;
}

function historyReadResponse(frame) {
  if (frame.method !== "session/read" || !process.env.MUSE_TEST_HISTORY_READ) return false;
  const child = process.env.MUSE_TEST_HISTORY_CHILD;
  if (process.env.MUSE_TEST_HISTORY_CHILD_MISSING && frame.params.sessionId === "fixture-child") {
    rpcError(frame, -32020, "sessionNotFound", "missing");
    return true;
  }
  if (process.env.MUSE_TEST_HISTORY_CHILD_ERROR && frame.params.sessionId === "fixture-child") {
    rpcError(frame, -32001, "overloaded", "busy");
    return true;
  }
  const source = child ? readFixture("phase3-child-read") : rows;
  const result = responseFor(source, child ? "session/read" : "session/resume");
  result.session.sessionId = frame.params.sessionId;
  if (child && frame.params.sessionId === "fixture-child") {
    result.session.title = "History child";
    result.session.workspaceRoot = "/tmp/muse-phase0/child";
  }
  respond(frame, result);
  return true;
}

function historyPageResponse(frame) {
  let result;
  if (process.env.MUSE_TEST_GAP || process.env.MUSE_TEST_SILENT) {
    result = {
      events: replace(
        rows
          .filter(
            (row) =>
              row.dir === "in" &&
              row.msg.method &&
              row.msg.params?.viewCursor &&
              !row.msg.id &&
              row.msg.method !== "item/delta",
          )
          .map((row) => ({ method: row.msg.method, params: row.msg.params })),
      ),
      nextCursor: null,
    };
  } else {
    result = replace(
      responseFor(
        readFixture(
          frame.params.sessionId === "fixture-child" || process.env.MUSE_TEST_HISTORY_CHILD
            ? "phase3-child-read"
            : "phase3-controls",
        ),
        "view/page",
      ),
    );
    if (process.env.MUSE_TEST_HISTORY_CHILD && frame.params.sessionId !== "fixture-child") {
      const childItems = readFixture("subagent")
        .filter(
          (row) =>
            row.dir === "in" &&
            (row.msg.method === "item/started" || row.msg.method === "item/completed") &&
            row.msg.params?.item?.tool === "subagent_spawn",
        )
        .map((row) => ({
          method: row.msg.method,
          params: {
            ...row.msg.params,
            item: { ...row.msg.params.item, childSessionId: "fixture-child" },
          },
        }));
      result.events.push(...childItems);
    }
    for (const event of result.events) event.params.sessionId = frame.params.sessionId;
  }
  if (process.env.MUSE_TEST_HISTORY_PAGE_SIZE) {
    const offset =
      result.events.findIndex((event) => event.params.viewCursor === frame.params.cursor) + 1;
    const events = result.events.slice(
      offset,
      offset + Number(process.env.MUSE_TEST_HISTORY_PAGE_SIZE),
    );
    result = {
      events,
      nextCursor:
        offset + events.length < result.events.length ? events.at(-1).params.viewCursor : null,
    };
  }
  respond(frame, result);
  return true;
}
function skillResponse(frame) {
  if (frame.method === "skill/list") {
    const skillRows =
      scenario.startsWith("phase3-") && rows.some((row) => row.msg.method === "skill/list")
        ? rows
        : readFixture("skill");
    const result = responseFor(skillRows, "skill/list");
    if (process.env.MUSE_TEST_SKILLS_CHANGED && counts.has("skill-read")) result.skills = [];
    counts.set("skill-read", 1);
    respond(frame, result);
    return true;
  }
  return false;
}

function workflowResponse(frame) {
  if (frame.method === "view/page" && process.env.MUSE_TEST_WORKFLOW) {
    const result = responseFor(readFixture("phase3-default-workflow"), "view/page");
    result.events = result.events.filter(
      (event) => event.params.item?.kind === "workflow" || event.params.item?.tool === "workflow",
    );
    for (const event of result.events) event.params.sessionId = frame.params.sessionId;
    respond(frame, result);
    return true;
  }
  return false;
}

function queuedResponse(frame) {
  if (
    process.env.MUSE_TEST_QUEUE &&
    frame.method === "turn/start" &&
    counts.get(frame.method) === 1
  ) {
    respond(frame, {
      turnId: frame.params.commandId,
      disposition: "queued",
      startedNewTurn: false,
    });
    return true;
  }
  return false;
}
function retryResponse(frame, count) {
  if (process.env.MUSE_TEST_RETRY === frame.method && count === 0) {
    counts.set(frame.method, 0);
    delete process.env.MUSE_TEST_RETRY;
    replacements.set("retryCommandId", frame.params.commandId);
    rpcError(frame, -32001, process.env.MUSE_TEST_RETRY_KIND || "overloaded", "busy");
    return true;
  }
  if (
    replacements.has("retryCommandId") &&
    replacements.get("retryCommandId") !== frame.params.commandId
  )
    throw new Error("Retry changed commandId");
  replacements.delete("retryCommandId");
  return false;
}
function validateCommand(frame, recorded) {
  if (recorded.params.commandId) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        frame.params.commandId,
      )
    )
      throw new Error("Not UUIDv7");
    replacements.set(recorded.params.commandId, frame.params.commandId);
  }
  if (
    frame.method === "approval/decide" &&
    recorded.params.requirementId.sourceIndex !== frame.params.requirementId.sourceIndex
  )
    throw new Error("Wrong approval stage");
}
function emitFixtureMessage(recordedMessage, recorded, frame) {
  const message = replace(recordedMessage);
  if (!message.method && message.id === recorded.id) message.id = frame.id;
  if (
    message.method === "session/closed" ||
    (message.method === "session/statusChanged" && message.params.status === "notLoaded")
  )
    return;
  if (frame.method === "session/start" && message.result?.session?.approvalMode)
    message.result.session.approvalMode.mode = frame.params.approvalMode;
  applyWireVariants(message);
  if (message.result?.viewCursor && process.env.MUSE_TEST_EMPTY_CURSOR)
    message.result.viewCursor = "";
  applyTestVariants(message);
  if (parityDelivery(message)) return;
  if (message.method && message.id !== undefined) receipts.add(message.id);
  send(message);
  if (
    process.env.MUSE_TEST_STALE &&
    message.method === "item/completed" &&
    message.params.item.kind === "agentMessage"
  ) {
    send({
      ...message,
      params: {
        ...message.params,
        item: { ...message.params.item, revision: 1, text: "STALE_REVISION" },
      },
    });
  }
}
function applyWireVariants(message) {
  if (
    message.method === "item/delta" &&
    message.params?.field === "text" &&
    process.env.MUSE_TEST_IMPLICIT_TEXT_DELTA
  ) {
    delete message.params.field;
  }
  if (message.result?.session && process.env.MUSE_TEST_NULL_MODEL) {
    message.result.session.modelId = null;
    message.result.session.providerId = null;
  }
}
function parityDelivery(message) {
  if (process.env.MUSE_TEST_WORKFLOW && message.method === "turn/completed")
    send({
      jsonrpc: "2.0",
      method: "view/gap",
      params: { sessionId: message.params.sessionId, after: "", next: message.params.viewCursor },
    });
  if (
    process.env.MUSE_TEST_SILENT &&
    ["item/started", "item/delta", "item/completed", "turn/completed"].includes(message.method) &&
    message.params.item?.kind !== "userMessage"
  )
    return true;
  if (
    process.env.MUSE_TEST_GAP &&
    message.method === "item/completed" &&
    message.params.item.kind === "agentMessage"
  ) {
    send({
      jsonrpc: "2.0",
      method: "view/gap",
      params: {
        sessionId: message.params.sessionId,
        after: "fixture-last-cursor",
        next: message.params.viewCursor,
      },
    });
    return true;
  }
  if (process.env.MUSE_TEST_SKILLS_CHANGED && message.method === "turn/completed")
    send({
      jsonrpc: "2.0",
      method: "skill/changed",
      params: { sessionId: message.params.sessionId },
    });
  return false;
}
function applyTestVariants(message) {
  applyParityVariants(message);
  if (message.method === "turn/completed" && process.env.MUSE_TEST_INTERRUPT_TERMINAL)
    message.params.terminal = process.env.MUSE_TEST_INTERRUPT_TERMINAL;
  if (message.params?.availableChoices && process.env.MUSE_TEST_CHOICES)
    message.params.availableChoices = message.params.availableChoices.toReversed();
  if (message.method === "turn/completed" && process.env.MUSE_TEST_AUTH_REQUIRED) {
    message.params.terminal = "failed";
    message.params.error = { kind: "authRequired", message: "authentication expired" };
  }
  if (message.result?.schema && process.env.MUSE_TEST_FINGERPRINT)
    message.result.schema.fingerprint = process.env.MUSE_TEST_FINGERPRINT;
  if (message.params?.item?.tool === "read_file" && process.env.MUSE_TEST_TOOL) {
    message.params.item.tool = process.env.MUSE_TEST_TOOL;
    message.params.item.args = JSON.stringify({
      path: "f",
      query: "needle",
      url: "https://example.com",
    });
  }
  if (message.params?.item?.tool === "read_file" && process.env.MUSE_TEST_UNKNOWN_KIND) {
    message.params.item.kind = "futureItem";
    message.params.item.fallbackText = "New MSP item";
  }
}
function applyParityVariants(message) {
  if (process.env.MUSE_TEST_CHILD && message.params?.item?.tool === "subagent_spawn") {
    message.params.item.childSessionId = "fixture-child";
    if (process.env.MUSE_TEST_CHILD === "workflow") message.params.item.kind = "workflow";
    if (process.env.MUSE_TEST_CHILD === "dedicated") {
      message.params.item.kind = "subagent";
      message.params.item.role = "worker";
      message.params.item.objective = "Child objective";
    }
  }
  if (message.params?.availableChoices && process.env.MUSE_TEST_DENIED)
    message.params.availableChoices.push({
      choiceId: "reject_once",
      decision: "denied",
      scope: "once",
      label: "Reject tool",
    });
}
lines.on("close", () => {
  if (process.env.MUSE_TEST_REQUESTS)
    appendFileSync(process.env.MUSE_TEST_REQUESTS, JSON.stringify({ event: "hostClosed" }) + "\n");
  if (receipts.size) throw new Error("Missing presentation receipt");
});
function readFixture(name) {
  const transcript = readFileSync(path.join(root, name + ".ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // The duplicate-decision probe is a separate negative action, not part of the approval flow.
  const duplicateIds = new Set(
    transcript
      .filter((row) => row.msg.error?.data?.kind === "approvalAlreadyResolved")
      .map((row) => row.msg.id),
  );
  return transcript.filter((row) => !duplicateIds.has(row.msg.id));
}
function responseFor(transcript, method) {
  const request = transcript.find((row) => row.dir === "out" && row.msg.method === method);
  return transcript.find(
    (row) => row.dir === "in" && row.msg.id === request.msg.id && !row.msg.method,
  ).msg.result;
}
function replace(value) {
  if (typeof value === "string") return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map(replace);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
  return value;
}
function send(frame) {
  if (frame.method === "item/completed" && process.env.MUSE_TEST_HISTORY) {
    appendFileSync(process.env.MUSE_TEST_HISTORY, JSON.stringify(frame.params.item) + "\n");
  }
  process.stdout.write(JSON.stringify(frame) + "\n");
}
function respond(frame, result) {
  send({ jsonrpc: "2.0", id: frame.id, result });
}
function rpcError(frame, code, kind, message) {
  send({ jsonrpc: "2.0", id: frame.id, error: { code, message, data: { kind } } });
}
