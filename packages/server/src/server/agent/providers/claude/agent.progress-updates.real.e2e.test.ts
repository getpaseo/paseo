import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentSession, AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

// Reproduces #6199 through the real Claude provider. Claude Opus 5.5 writes the
// text it means for the user between tool calls as a "progress update": a
// thinking block that Claude Code marks with `narration_block_indexes`.
const PROMPT =
  "There are three plan files in this directory: plan-a.txt, plan-b.txt and plan-c.txt. Read each one, tell me how they compare on cost, time and risk, and then ask me which plan to pick using your AskUserQuestion tool. Keep me posted as you go.";

const handles: Array<{ cwd: string; session: AgentSession }> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.session.close().catch(() => undefined);
    rmSync(handle.cwd, { recursive: true, force: true });
  }
});

function writePlans(cwd: string): void {
  writeFileSync(
    path.join(cwd, "plan-a.txt"),
    "Plan A\nCost: 3 credits\nTime: 2 days\nRisk: needs a manual review step\n",
  );
  writeFileSync(
    path.join(cwd, "plan-b.txt"),
    "Plan B\nCost: 5 credits\nTime: 1 day\nRisk: none known\n",
  );
  writeFileSync(
    path.join(cwd, "plan-c.txt"),
    "Plan C\nCost: 2 credits\nTime: 4 days\nRisk: depends on an external vendor\n",
  );
}

async function runPlanComparison(): Promise<{
  items: AgentTimelineItem[];
  narration: string[];
}> {
  const cwd = mkdtempSync(path.join(tmpdir(), "claude-progress-updates-"));
  writePlans(cwd);
  const narration: string[] = [];
  const logger = pino(
    { level: "trace" },
    {
      write(line) {
        const record = JSON.parse(line) as {
          rawEvent?: {
            type?: string;
            narration_block_indexes?: number[];
            message?: { content?: Array<{ type: string; thinking?: string }> };
          };
        };
        const frame = record.rawEvent;
        if (frame?.type !== "assistant") return;
        for (const index of frame.narration_block_indexes ?? []) {
          const block = frame.message?.content?.[index];
          if (block?.type === "thinking" && block.thinking) narration.push(block.thinking);
        }
      },
    },
  );
  const client = new ClaudeAgentClient({ logger });
  const session = await client.createSession({
    provider: "claude",
    cwd,
    model: "claude-opus-5-5",
    thinkingOptionId: "xhigh",
    modeId: "bypassPermissions",
  });
  handles.push({ cwd, session });

  const items: AgentTimelineItem[] = [];
  await new Promise<void>((resolve, reject) => {
    session.subscribe((event: AgentStreamEvent) => {
      if (event.type === "timeline") items.push(event.item);
      if (event.type === "turn_failed") reject(new Error(event.error));
      if (
        event.type === "permission_requested" ||
        event.type === "turn_completed" ||
        event.type === "turn_failed"
      ) {
        resolve();
      }
    });
    void session.startTurn(PROMPT).catch(reject);
  });

  return { items, narration };
}

test("the comparison written before AskUserQuestion reaches the timeline as assistant text", async () => {
  const { items, narration } = await runPlanComparison();
  const lastReadIndex = items.findLastIndex(
    (item) => item.type === "tool_call" && item.name !== "AskUserQuestion",
  );
  const askIndex = items.findIndex(
    (item) => item.type === "tool_call" && item.name === "AskUserQuestion",
  );
  expect(askIndex).toBeGreaterThan(lastReadIndex);
  const between = items.slice(lastReadIndex + 1, askIndex);
  const assistantText = between
    .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
    .join("");
  expect(assistantText).toMatch(/plan/i);
  // A plain-text model response would not exercise narration classification.
  expect(narration.length).toBeGreaterThan(0);
  for (const text of narration) {
    expect(
      items.flatMap((item) => (item.type === "assistant_message" ? [item.text] : [])).join(""),
    ).toContain(text);
    expect(
      items.flatMap((item) => (item.type === "reasoning" ? [item.text] : [])).join(""),
    ).not.toContain(text);
  }
}, 280_000);
