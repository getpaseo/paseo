import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { CodexAppServerAgentClient } from "../codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
  type FakeCodexHistoryOptions,
  type FakeCodexHistoryThread,
  fakeCodexThreadHistory,
} from "./test-utils/fake-app-server.js";

function userItem(id: string, text: string) {
  return { type: "userMessage", id, content: [{ type: "text", text }] };
}

function agentItem(id: string, text: string) {
  return { type: "agentMessage", id, text };
}

async function openCodexThread(
  thread: FakeCodexHistoryThread,
  options?: FakeCodexHistoryOptions,
): Promise<{ appServer: FakeCodexAppServer; session: AgentSession }> {
  const appServer = createFakeCodexAppServer(
    fakeCodexThreadHistory({ "saved-thread": thread }, options),
  );
  const provider = new CodexAppServerAgentClient(createTestLogger());
  const internals = provider as unknown as {
    goalsEnabledPromise: Promise<boolean> | null;
    autoReviewEnabledPromise: Promise<boolean> | null;
    spawnAppServer: () => Promise<ChildProcessWithoutNullStreams>;
  };
  internals.goalsEnabledPromise = Promise.resolve(false);
  internals.autoReviewEnabledPromise = Promise.resolve(false);
  internals.spawnAppServer = async () => appServer.child;
  const session = await provider.resumeSession({ sessionId: "saved-thread" });
  return { appServer, session };
}

async function readHistory(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) events.push(event);
  return events;
}

function timelineItems(events: AgentStreamEvent[]) {
  return events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
}

function historyRequests(appServer: FakeCodexAppServer) {
  return appServer
    .requests()
    .filter(
      (request) =>
        request.method === "thread/read" ||
        request.method === "thread/turns/list" ||
        request.method === "thread/items/list",
    )
    .map((request) => ({ method: request.method, params: request.params }));
}

describe("Codex thread history", () => {
  test("loads a paginated thread through pages", async () => {
    const answers = Array.from({ length: 150 }, (_, index) =>
      agentItem(`agent-${index}`, `Answer ${index}`),
    );
    const { appServer, session } = await openCodexThread({
      historyMode: "paginated",
      turns: [
        {
          id: "turn-1",
          startedAt: 1_778_832_941,
          completedAt: 1_778_833_000,
          items: [userItem("user-1", "First"), ...answers.slice(0, 120)],
        },
        {
          id: "turn-2",
          startedAt: 1_778_833_094,
          completedAt: 1_778_833_100,
          items: [userItem("user-2", "Second"), ...answers.slice(120)],
        },
      ],
    });
    try {
      const events = await readHistory(session);

      expect(timelineItems(events)).toEqual([
        { type: "user_message", text: "First", messageId: "user-1" },
        ...answers.slice(0, 120).map((answer) => ({
          type: "assistant_message",
          text: answer.text,
          messageId: answer.id,
        })),
        { type: "user_message", text: "Second", messageId: "user-2" },
        ...answers.slice(120).map((answer) => ({
          type: "assistant_message",
          text: answer.text,
          messageId: answer.id,
        })),
      ]);
      const timestamps = events.flatMap((event) =>
        event.type === "timeline" ? [event.timestamp] : [],
      );
      expect(timestamps[0]).toBe("2026-05-15T08:15:41.000Z");
      expect(timestamps[1]).toBe("2026-05-15T08:16:40.000Z");
      expect(timestamps[121]).toBe("2026-05-15T08:18:14.000Z");
      const requests = historyRequests(appServer);
      expect(requests).not.toContainEqual(
        expect.objectContaining({ params: expect.objectContaining({ includeTurns: true }) }),
      );
      const itemPages = requests.filter((request) => request.method === "thread/items/list");
      expect(itemPages.length).toBeGreaterThan(1);
      for (const page of itemPages) {
        expect(page.params).toMatchObject({ threadId: "saved-thread", sortDirection: "asc" });
        expect((page.params as { limit: number }).limit).toBeLessThanOrEqual(100);
      }
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("loads a paginated thread whose full read Codex 0.145 rejects", async () => {
    const { appServer, session } = await openCodexThread({
      historyMode: "paginated",
      turns: [{ id: "turn-1", items: [userItem("user-1", "Hello"), agentItem("agent-1", "Hi")] }],
    });
    try {
      expect(timelineItems(await readHistory(session))).toEqual([
        { type: "user_message", text: "Hello", messageId: "user-1" },
        { type: "assistant_message", text: "Hi", messageId: "agent-1" },
      ]);
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("a page too big to send shows a warning row and stops loading", async () => {
    const answers = Array.from({ length: 120 }, (_, index) =>
      agentItem(`agent-${index}`, `Answer ${index}`),
    );
    const { appServer, session } = await openCodexThread(
      {
        historyMode: "paginated",
        turns: [
          { id: "turn-1", items: [userItem("user-1", "One"), ...answers] },
          { id: "turn-2", items: [userItem("user-2", "Two"), agentItem("huge", "never sent")] },
        ],
      },
      { oversizedItemIds: ["huge"] },
    );
    const loaded = [
      { type: "user_message", text: "One", messageId: "user-1" },
      ...answers.slice(0, 99).map((answer) => ({
        type: "assistant_message",
        text: answer.text,
        messageId: answer.id,
      })),
      {
        type: "notification",
        level: "warning",
        message: "The rest of this Codex thread's history is too large to load.",
      },
    ];
    try {
      expect(timelineItems(await readHistory(session))).toEqual(loaded);
      // The oversized reply failed only its own request; the session still answers.
      expect(timelineItems(await readHistory(session))).toEqual(loaded);
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("loads a legacy thread that fits in one read", async () => {
    const { appServer, session } = await openCodexThread({
      historyMode: "legacy",
      turns: [{ id: "turn-1", items: [userItem("user-1", "Hello"), agentItem("agent-1", "Hi")] }],
    });
    try {
      expect(timelineItems(await readHistory(session))).toEqual([
        { type: "user_message", text: "Hello", messageId: "user-1" },
        { type: "assistant_message", text: "Hi", messageId: "agent-1" },
      ]);
      expect(historyRequests(appServer).map((request) => request.method)).not.toContain(
        "thread/items/list",
      );
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("a legacy thread too big for one read shows the migration command", async () => {
    const { appServer, session } = await openCodexThread(
      {
        historyMode: "legacy",
        turns: [{ id: "turn-1", items: [userItem("user-1", "Hello"), agentItem("huge", "x")] }],
      },
      { oversizedItemIds: ["huge"] },
    );
    const migrationRow = {
      type: "notification",
      level: "warning",
      message: expect.stringContaining("codex migrate-rollouts --apply --thread saved-thread"),
    };
    try {
      expect(timelineItems(await readHistory(session))).toEqual([migrationRow]);
      // The session stays up for the user to prompt until they archive it to migrate.
      expect(timelineItems(await readHistory(session))).toEqual([migrationRow]);
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });
});
