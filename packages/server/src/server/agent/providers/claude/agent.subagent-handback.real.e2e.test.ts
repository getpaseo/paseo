import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { expect, test } from "vitest";

import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";

const ROOT_PROMPT = `Use Claude Code's native Agent tool exactly once, never Paseo tools, with this complete task:

Do not use any tools. Reply with exactly this markdown report and nothing else:
## HANDBACK_HEADING
- **HANDBACK_BOLD** item

Then reply exactly ROOT_DONE.`;

function subagentItems(events: AgentStreamEvent[]): AgentTimelineItem[] {
  return events.flatMap((event) =>
    event.type === "provider_subagent" && event.event.type === "timeline" ? [event.event.item] : [],
  );
}

function expectHandbackAsReport(items: AgentTimelineItem[]): void {
  expect(items.filter((item) => item.type === "tool_call")).toEqual([]);
  expect(
    items.flatMap((item) => (item.type === "assistant_message" ? [item.text] : [])).join(""),
  ).toContain("## HANDBACK_HEADING\n- **HANDBACK_BOLD** item");
}

test("an auto-mode Claude subagent's handback report shows as its final message", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-claude-subagent-handback-"));
  const client = new ClaudeAgentClient({ logger: pino({ level: "warn" }) });
  const session = await client.createSession({ provider: "claude", cwd, modeId: "auto" });
  try {
    const events = await collectSessionTurnEvents(session, ROOT_PROMPT);
    expectHandbackAsReport(subagentItems(events));

    const persistence = session.describePersistence();
    expect(persistence).not.toBeNull();
    await session.close();
    const restored = await client.resumeSession(persistence!, { cwd });
    try {
      const replayed: AgentStreamEvent[] = [];
      for await (const event of restored.streamHistory()) replayed.push(event);
      expectHandbackAsReport(subagentItems(replayed));
    } finally {
      await restored.close();
    }
  } finally {
    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 240_000);
