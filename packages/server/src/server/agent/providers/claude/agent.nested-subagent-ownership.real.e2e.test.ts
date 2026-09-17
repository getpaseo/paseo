import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";

const ROOT_PROMPT = `You are ROOT_OWNER. Use Claude Code's native Agent tool exactly once, never Paseo tools.
Name the agent direct_owner and give it this complete task:

You are DIRECT_OWNER. Use Claude Code's native Agent tool exactly once. Name that agent nested_owner and give it this complete task:
You are NESTED_OWNER. Use Bash exactly once to run \`sleep 2; printf 'NESTED_BACKGROUND_SENTINEL\\n'\` with run_in_background true. Use TaskOutput with block true to wait for the Bash task, verify its exit code is 0 and output is NESTED_BACKGROUND_SENTINEL, and wait for its completion notification before replying exactly NESTED_DONE. Do not finish while the command is running.
Wait for nested_owner to finish, then reply exactly DIRECT_DONE.

Wait for direct_owner to finish, then reply exactly ROOT_DONE.`;

test("attributes a nested Claude child and its background notification to their direct owners", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-claude-nested-ownership-"));
  const client = new ClaudeAgentClient({ logger: pino({ level: "trace" }) });
  const session = await client.createSession({
    provider: "claude",
    cwd,
    model: "claude-sonnet-5",
    modeId: "bypassPermissions",
  });
  try {
    const events = await collectSessionTurnEvents(session, ROOT_PROMPT);

    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed" }));
    expect(
      events
        .flatMap((event) =>
          event.type === "timeline" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        )
        .join("")
        .trim(),
    ).toBe("ROOT_DONE");
    const descriptors = events
      .filter((event) => event.type === "provider_subagent" && event.event.type === "upsert")
      .map((event) => event.event)
      .filter((event) => event.type === "upsert" && event.description);
    const direct = descriptors.find((event) => event.description === "direct_owner");
    const nested = descriptors.find((event) => event.description === "nested_owner");

    expect(direct).toMatchObject({ description: "direct_owner" });
    expect(nested).toMatchObject({ description: "nested_owner" });
    expect(nested?.parentSubagentId).toBe(direct?.id);
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
    const notification = events
      .flatMap((event) =>
        event.type === "provider_subagent" &&
        event.event.type === "timeline" &&
        event.event.id === nested?.id &&
        event.event.item.type === "tool_call" &&
        event.event.item.name === "task_notification"
          ? [event.event.item]
          : [],
      )
      .at(-1);
    expect(notification?.metadata?.status).toBe("completed");
    const outputFile = notification?.metadata?.outputFile;
    expect(typeof outputFile).toBe("string");
    expect(readFileSync(outputFile as string, "utf8").trim()).toMatch(
      /^NESTED_BACKGROUND_SENTINEL\s+\[exited with code 0\]$/,
    );

    const persistence = session.describePersistence();
    expect(persistence).not.toBeNull();
    await session.close();
    const restored = await client.resumeSession(persistence!, { cwd });
    try {
      const replayed: AgentStreamEvent[] = [];
      for await (const event of restored.streamHistory()) replayed.push(event);
      expect(
        replayed.filter(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.name === "task_notification",
        ),
      ).toEqual([]);
      expect(replayed).toContainEqual(
        expect.objectContaining({
          type: "provider_subagent",
          event: expect.objectContaining({
            type: "upsert",
            id: nested?.id,
            parentSubagentId: direct?.id,
          }),
        }),
      );
      expect(replayed).toContainEqual(
        expect.objectContaining({
          type: "provider_subagent",
          event: expect.objectContaining({
            type: "timeline",
            id: nested?.id,
            item: expect.objectContaining({
              name: "task_notification",
              metadata: expect.objectContaining({
                toolUseId: notification?.metadata?.toolUseId,
                status: "completed",
              }),
            }),
          }),
        }),
      );
    } finally {
      await restored.close();
    }
  } finally {
    await session.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 360_000);
