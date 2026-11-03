import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

/** Full-scale reproduction is opt-in: run this file with ROOT children --generate. */
export function generateReplayCorpus(
  root: string,
  size = { parentMiB: 395, childrenMiB: 362, children: 269 },
): { cwd: string; configDir: string } {
  const cwd = path.join(root, "repo");
  const configDir = path.join(root, "claude");
  mkdirSync(cwd, { recursive: true });
  const project = claudeProjectDirSync(cwd, { configDir });
  const subagents = path.join(project, "large-session", "subagents");
  mkdirSync(subagents, { recursive: true });
  const parent = path.join(project, "large-session.jsonl");
  const row = (value: unknown) => JSON.stringify(value) + "\n";
  // Large transcripts include records and context summaries that never become timeline items.
  // Generate those incrementally: the fixture generator itself must not hold the corpus.
  const padding = row({ type: "progress", data: "x".repeat(64 * 1024) });
  writeFileSync(parent, "");
  for (let i = 0; i < Math.ceil((size.parentMiB * 1024 * 1024) / padding.length); i++) {
    appendFileSync(parent, padding);
  }
  appendFileSync(parent, row({ type: "user", message: { content: "Open the large session" } }));
  for (let i = 0; i < size.children; i++) {
    const agentId = `child-${i}`;
    const id = `task-${i}`;
    appendFileSync(
      parent,
      row({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id, name: "Task", input: { description: agentId } }],
        },
      }),
    );
    appendFileSync(
      parent,
      row({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
      }),
    );
    const file = path.join(subagents, `agent-${agentId}.jsonl`);
    writeFileSync(file, "");
    const summary = row({
      type: "user",
      isCompactSummary: true,
      isSidechain: true,
      agentId,
      message: { content: "x".repeat(64 * 1024) },
    });
    for (
      let j = 0;
      j < Math.ceil((size.childrenMiB * 1024 * 1024) / size.children / summary.length);
      j++
    )
      appendFileSync(file, summary);
    appendFileSync(
      file,
      row({
        type: "assistant",
        isSidechain: true,
        agentId,
        timestamp: "2026-07-26T06:28:00.000Z",
        message: {
          content: [{ type: "text", text: `History of ${agentId}` }],
          stop_reason: "end_turn",
        },
      }),
    );
    writeFileSync(
      path.join(subagents, `agent-${agentId}.meta.json`),
      JSON.stringify({ toolUseId: id }),
    );
  }
  return { cwd, configDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: replay-memory.fixture.ts ROOT children|workflow [--generate]");
  if (process.argv.includes("--generate")) {
    if (process.argv[3] === "workflow") generateWorkflowReplayCorpus(root);
    else generateReplayCorpus(root);
  }
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    queryFactory: () => {
      throw new Error("Replay must not query Claude");
    },
    resolveVersion: async () => "2.1.220",
  });
  const session = await client.resumeSession(
    { provider: "claude", sessionId: "large-session" },
    { cwd: path.join(root, "repo") },
  );
  let parentItems = 0;
  const completed = new Set<string>();
  const histories = new Set<string>();
  for await (const event of session.streamHistory()) {
    if (event.type === "timeline") parentItems++;
    if (
      event.type === "provider_subagent" &&
      event.event.type === "upsert" &&
      event.event.status === "completed"
    )
      completed.add(event.event.id);
    if (
      event.type === "provider_subagent" &&
      event.event.type === "timeline" &&
      event.event.item.type === "assistant_message"
    )
      histories.add(event.event.item.text);
  }
  await session.close();
  console.log(
    JSON.stringify({
      parentItems,
      completed: completed.size,
      histories: histories.size,
      maxRSSKiB: process.resourceUsage().maxRSS,
    }),
  );
}

export function generateWorkflowReplayCorpus(
  root: string,
  childMiB = 320,
): { cwd: string; configDir: string } {
  const cwd = path.join(root, "repo");
  const configDir = path.join(root, "claude");
  mkdirSync(cwd, { recursive: true });
  const project = claudeProjectDirSync(cwd, { configDir });
  const runId = "wf_large";
  const sessionDirectory = path.join(project, "large-session");
  const childrenDirectory = path.join(sessionDirectory, "subagents", "workflows", runId);
  mkdirSync(childrenDirectory, { recursive: true });
  mkdirSync(path.join(sessionDirectory, "workflows"), { recursive: true });
  writeFileSync(
    path.join(project, "large-session.jsonl"),
    [
      { type: "user", message: { content: "Open the large session" } },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "workflow-task", name: "Workflow", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "workflow-task",
              content: `Workflow launched in background.\nRun ID: ${runId}`,
            },
          ],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  writeFileSync(
    path.join(sessionDirectory, "workflows", `${runId}.json`),
    JSON.stringify({ runId, status: "completed", summary: "Large workflow" }),
  );
  for (let i = 0; i < 5; i++) {
    const file = path.join(childrenDirectory, `agent-child-${i}.jsonl`);
    writeFileSync(file, "");
    const prompt =
      JSON.stringify({
        type: "user",
        isSidechain: true,
        agentId: `child-${i}`,
        message: { content: "x".repeat(64 * 1024) },
      }) + "\n";
    for (let j = 0; j < Math.ceil((childMiB * 1024 * 1024) / prompt.length); j++)
      appendFileSync(file, prompt);
    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: `child-${i}`,
        timestamp: `2026-07-26T06:28:0${4 - i}.000Z`,
        message: {
          content: [{ type: "text", text: `History of child-${i}` }],
          stop_reason: "end_turn",
        },
      }) + "\n",
    );
  }
  return { cwd, configDir };
}
