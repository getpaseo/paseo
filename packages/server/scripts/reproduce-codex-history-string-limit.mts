// Opt-in diagnostic for #3905. Run from the repository root:
// node --import tsx packages/server/scripts/reproduce-codex-history-string-limit.mts 520 [legacy|paginated]
// Requires Codex 0.148+ on PATH and approximately 2 GiB of available memory.
// `paginated` migrates the synthetic rollout with `codex migrate-rollouts` first.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { CodexAppServerAgentSession } from "../src/server/agent/providers/codex-app-server-agent.js";

const megabytes = Number(process.argv[2] ?? "520");
if (!Number.isSafeInteger(megabytes) || megabytes < 1 || megabytes > 600) {
  throw new Error("Expected an integer size between 1 and 600 MiB");
}
const historyMode = process.argv[3] ?? "legacy";
if (historyMode !== "legacy" && historyMode !== "paginated") {
  throw new Error("Expected history mode legacy or paginated");
}
const root = await mkdtemp(path.join(process.cwd(), ".codex-history-repro-"));
const home = path.join(root, "codex-home");
const now = new Date();
const timestamp = now.toISOString();
const threadId = randomUUID();
const turnId = randomUUID();
const sessions = path.join(home, "sessions", ...timestamp.slice(0, 10).split("-"));
await mkdir(sessions, { recursive: true });
const rollout = await open(
  path.join(sessions, `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${threadId}.jsonl`),
  "w",
);
async function write(type: string, payload: unknown) {
  await rollout.write(`${JSON.stringify({ timestamp, type, payload })}\n`);
}
await write("session_meta", {
  id: threadId,
  timestamp,
  cwd: root,
  originator: "codex_cli_rs",
  cli_version: "0.159.0",
  source: "cli",
  model_provider: "openai",
  history_mode: "legacy",
});
await write("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 200000 });
await write("event_msg", {
  type: "user_message",
  message: "Synthetic oversized history",
  images: [],
  local_images: [],
  text_elements: [],
});
for (let index = 0; index < megabytes; index++) {
  await write("event_msg", {
    type: "agent_message",
    message: "x".repeat(1024 * 1024),
    phase: "commentary",
  });
}
await write("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "done" });
await rollout.close();
if (historyMode === "paginated") {
  execFileSync("codex", ["migrate-rollouts", "--apply", "--thread", threadId], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: "ignore",
  });
}
console.log(
  `Opening synthetic ${megabytes} MiB ${historyMode} history through the real Codex app-server`,
);
const session = new CodexAppServerAgentSession(
  { provider: "codex", cwd: root },
  { sessionId: threadId },
  pino({ level: "silent" }),
  async () =>
    spawn(
      "codex",
      ["app-server", "--disable", "plugins", "--disable", "apps", "--disable", "remote_plugin"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_HOME: home },
      },
    ),
  { codexHome: home },
  false,
  false,
  false,
  undefined,
  "history",
);
try {
  await session.connect();
  let count = 0;
  for await (const event of session.streamHistory()) {
    if (event.type !== "timeline") continue;
    count++;
    if (event.item.type === "notification") console.log(event.item.message);
  }
  console.log(`History loaded: ${count} timeline rows`);
} catch (error) {
  // A recoverable session error is acceptable for the crash-isolation assertion.
  console.log(
    `History rejected without crashing: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await session.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
