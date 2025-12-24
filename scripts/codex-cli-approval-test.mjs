import { spawn } from "node:child_process";
import readline from "node:readline";

const PROMPT =
  'Run this command exactly: ["bash", "-lc", "echo ok > mcp-smoke.txt"].';

const args = [
  "exec",
  "--json",
  "-s",
  "read-only",
  "-c",
  'approval_policy="on-request"',
  PROMPT,
];

const child = spawn("codex", args, {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

const rl = readline.createInterface({ input: child.stdout });
const events = [];

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  try {
    const event = JSON.parse(line);
    events.push(event);
    console.log(JSON.stringify(event));
  } catch (error) {
    console.error("Failed to parse JSONL line:", line);
    console.error(error);
  }
});

child.on("exit", (code) => {
  rl.close();
  console.log(`\nProcess exited with code ${code ?? "null"}.`);
  const approvalEvents = events.filter(
    (event) =>
      typeof event?.type === "string" &&
      event.type.includes("approval")
  );
  console.log(
    `Approval events: ${approvalEvents.length ? "yes" : "no"}`
  );
  if (approvalEvents.length) {
    console.log(JSON.stringify(approvalEvents, null, 2));
  }
});
