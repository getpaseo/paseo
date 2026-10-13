import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import type { AgentSession } from "../agent-sdk-types.js";

// A protocol peer exercises the public session interface without a Codex install.
test("marks set, pause, resume and clear as user goal mutations", async () => {
  const root = mkdtempSync(path.resolve(".dev-goal-protocol-"));
  const script = path.join(root, "codex.cjs");
  const capture = path.join(root, "requests.jsonl");
  writeFileSync(
    script,
    `
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.162.1");
  process.exit(0);
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  fs.appendFileSync(process.env.CAPTURE, JSON.stringify(request) + "\\n");
  let result = {};
  if (request.method === "initialize") result = { userAgent: "codex-cli/0.162.1" };
  if (request.method === "thread/start") result = { thread: { id: "goal-thread" } };
  if (request.method === "thread/loaded/list") result = { data: ["goal-thread"] };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
  );
  const client = new CodexAppServerAgentClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { CODEX_HOME: root, CAPTURE: capture },
  });
  let session: AgentSession | null = null;
  try {
    session = await client.createSession({
      provider: "codex",
      cwd: root,
      model: "test-model",
      thinkingOptionId: "low",
    });
    for (const command of ["/goal ship feature", "/goal pause", "/goal resume", "/goal clear"]) {
      const handler = session.tryHandleOutOfBand?.(command);
      if (!handler) throw new Error(`Missing handler for ${command}`);
      await handler.run({ emit: () => {} });
    }
    const requests = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const mutations = requests.filter((request) => request.method.startsWith("thread/goal/"));
    expect(mutations.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "thread/goal/set",
        params: {
          threadId: "goal-thread",
          origin: "user",
          objective: "ship feature",
          status: "active",
        },
      },
      {
        method: "thread/goal/set",
        params: { threadId: "goal-thread", origin: "user", status: "paused" },
      },
      {
        method: "thread/goal/set",
        params: { threadId: "goal-thread", origin: "user", status: "active" },
      },
      { method: "thread/goal/clear", params: { threadId: "goal-thread", origin: "user" } },
    ]);
  } finally {
    try {
      await session?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
