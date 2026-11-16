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
  process.stdout.write(`${process.env.AGY_TEST_VERSION || "1.5.9"}\n`);
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
if (args.includes("acp")) serveAcp();
else drive();

// ACP over stdio, limited to the history read: initialize, then session/load streams the
// fixture's session/update notifications around its reply. AGY_TEST_ACP=error fails the load;
// AGY_TEST_ACP=hang never answers it and ignores stdin EOF.
function serveAcp() {
  const mode = process.env.AGY_TEST_ACP;
  let load = null;
  function send(message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  function replay() {
    const { sessionId } = load.params;
    const notifications = fixture("acp-load");
    for (const notification of notifications) notification.params.sessionId = sessionId;
    // agy 1.5.9 can answer session/load while its history stream is still sending.
    const early = Math.ceil(notifications.length / 2);
    for (const notification of notifications.slice(0, early)) send(notification);
    send({ id: load.id, result: { sessionId } });
    for (const notification of notifications.slice(early)) send(notification);
    send({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "usage_update", used: 12, size: 100 } },
    });
  }
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      record({ acp: "initialize", params: message.params });
      send({
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      });
    } else if (message.method === "session/load") {
      record({ acp: "session/load", params: message.params });
      load = message;
      if (mode === "hang") setInterval(() => undefined, 1000);
      else if (mode === "error")
        send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
      else
        send({
          id: "agent-1",
          method: "fs/read_text_file",
          params: { sessionId: message.params.sessionId, path: "/workspace/README.md" },
        });
    } else if (message.id === "agent-1") {
      record({ acp: "response", message });
      replay();
    }
  });
  lines.on("close", () => {
    record({ acp: "eof" });
    if (mode !== "hang") process.exit(0);
  });
  process.on("SIGTERM", () => {
    record({ signal: "SIGTERM" });
    process.exit(1);
  });
}

function drive() {
  if (process.env.AGY_TEST_STARTUP === "auth") {
    process.stderr.write(fixture("not-signed-in", "stderr").join("\n"));
    process.stdout.write(JSON.stringify(fixture("not-signed-in")[0]) + "\n");
    process.exit(1);
  }
  if (process.env.AGY_TEST_STARTUP === "exit") process.exit(3);
  if (process.env.AGY_TEST_STARTUP === "stderr") {
    process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
    process.exit(1);
  }
  const resumeIndex = args.indexOf("--conversation");
  const conversationId =
    resumeIndex >= 0 ? args[resumeIndex + 1] : fixture("text-turn")[0].conversation_id;
  let denialResults = 0;
  function emit(frame) {
    const converted = structuredClone(frame);
    if (converted.conversation_id !== undefined) converted.conversation_id = conversationId;
    if (converted.step_update) converted.step_update.conversation_id = conversationId;
    if (converted.result) {
      converted.result.conversation_id = conversationId;
      if (process.env.AGY_TEST_DENIAL_COUNTS && converted.result.denied_actions?.length) {
        converted.result.denied_actions = Array.from(
          { length: Number(process.env.AGY_TEST_DENIAL_COUNTS.split(",")[denialResults++]) },
          () => converted.result.denied_actions[0],
        );
      }
    }
    process.stdout.write(JSON.stringify(converted) + "\n");
  }
  const init = fixture("text-turn")[0];
  if (args.includes("--model")) init.init.model = args[args.indexOf("--model") + 1];
  emit(init);
  let interrupted = null;
  const turns = new Map();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const input = JSON.parse(line);
    record({ input });
    const text = input.message.content;
    let name = "text-turn";
    if (text.includes("Attached image: ")) name = "image-file-external";
    if (text.includes("TOOLS")) name = "tools-default";
    if (text.includes("DENIAL_REPLAY")) name = "denial-replay";
    if (text.includes("SUBAGENT")) name = "subagent";
    if (text.includes("MULTI")) name = "multi-turn-reasoning";
    if (text.includes("RESUME")) name = "resume";
    if (text.includes("HANG")) name = "sigint-mid-text";
    if (text.includes("TOOL_HANG")) name = "sigint-mid-tool";
    const frames = fixture(name).slice(1);
    if (name.startsWith("sigint")) {
      interrupted = frames[frames.length - 1];
      for (const frame of frames.slice(0, -1)) emit(frame);
      return;
    }
    const count = frames.filter((frame) => frame.event === "result").length;
    const ordinal = (turns.get(name) || 0) % count;
    turns.set(name, ordinal + 1);
    let resultCount = 0;
    for (const frame of frames) {
      if (resultCount === ordinal) emit(frame);
      if (frame.event === "result") resultCount += 1;
    }
  });
  process.on("SIGINT", () => {
    record({ signal: "SIGINT" });
    if (process.env.AGY_TEST_IGNORE_SIGNALS === "yes") return;
    if (interrupted) emit(interrupted);
    process.exit(1);
  });
  process.on("SIGTERM", () => {
    record({ signal: "SIGTERM" });
    if (process.env.AGY_TEST_IGNORE_SIGNALS !== "yes") process.exit(1);
  });
  lines.on("close", () => process.exit(0));
}
