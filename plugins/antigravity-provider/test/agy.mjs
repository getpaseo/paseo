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
function emit(frame) {
  const converted = structuredClone(frame);
  if (converted.conversation_id !== undefined) converted.conversation_id = conversationId;
  if (converted.step_update) converted.step_update.conversation_id = conversationId;
  if (converted.result) converted.result.conversation_id = conversationId;
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
  if (text.includes("TOOLS")) name = "tools-default";
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
