import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
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
  process.stdout.write(`${process.env.AGY_TEST_VERSION || "1.2.13"}\n`);
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
  const emitted = [];
  for (const frame of frames) {
    if (resultCount === ordinal) {
      emitted.push(frame);
      emit(frame);
    }
    if (frame.event === "result") resultCount += 1;
  }
  appendTranscript(conversationId, text, emitted);
});

function appendTranscript(id, userText, frames) {
  const home = process.env.HOME;
  const result = frames.find((frame) => frame.event === "result")?.result;
  if (!home || !result) return;
  const dir = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    id,
    ".system_generated",
    "logs",
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "transcript_full.jsonl");
  const existingLines = existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  const baseIndex = existingLines * 2;
  const userStep = {
    step_index: baseIndex,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-11-02T16:27:03Z",
    content: `<USER_REQUEST>\n${userText}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-02T16:27:03Z.\n</ADDITIONAL_METADATA>`,
  };
  const assistantStep = {
    step_index: baseIndex + 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-02T16:27:04Z",
    ...(result.response ? { content: result.response } : {}),
  };
  appendFileSync(file, `${JSON.stringify(userStep)}\n${JSON.stringify(assistantStep)}\n`);
}
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
