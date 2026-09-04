import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

const ROOT_PROMPT = `You are ROOT_OWNER. Use Claude Code's native Agent tool exactly once, never Paseo tools.
Name the agent direct_owner and give it this complete task:

You are DIRECT_OWNER. Use Claude Code's native Agent tool exactly once. Name that agent nested_owner and give it this complete task:
You are NESTED_OWNER. Use Bash exactly once to run \`sleep 2; printf 'NESTED_BACKGROUND_SENTINEL\\n'\` with run_in_background true. Wait for the background command's completion notification, then reply exactly NESTED_DONE.
Wait for nested_owner to finish, then reply exactly DIRECT_DONE.

Wait for direct_owner to finish, then reply exactly ROOT_DONE.`;

function isTerminal(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

test("attributes a nested Claude child and its background notification to their direct owners", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-claude-nested-ownership-"));
  const session = await new ClaudeAgentClient({
    logger: pino({ level: "trace" }),
  }).createSession({
    provider: "claude",
    cwd,
    model: "claude-sonnet-5",
    modeId: "bypassPermissions",
  });
  const events: AgentStreamEvent[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for nested Claude reproduction")),
        300_000,
      );
      const unsubscribe = session.subscribe((event) => {
        events.push(event);
        if (!isTerminal(event)) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
      void session.startTurn(ROOT_PROMPT).catch((error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      });
    });

    const descriptors = events
      .filter((event) => event.type === "provider_subagent" && event.event.type === "upsert")
      .map((event) => event.event)
      .filter((event) => event.type === "upsert" && event.description);
    const nested = descriptors.find((event) => event.parentSubagentId);
    const direct = descriptors.find((event) => event.id === nested?.parentSubagentId);

    expect(direct).toBeDefined();
    expect(nested).toMatchObject({ parentSubagentId: direct?.id });
    expect(
      events.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.callId === nested?.id,
      ),
    ).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.name === "task_notification",
      ),
    ).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id: nested?.id,
          item: expect.objectContaining({
            type: "tool_call",
            name: "task_notification",
          }),
        }),
      }),
    );
  } finally {
    await session.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 360_000);
