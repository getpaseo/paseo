import { describe, expect, test } from "vitest";
import { readCodexThreadHistory, readCodexThreadHistoryPage } from "./thread-history.js";
import { CodexAppServerResponseTooLargeError } from "./app-server-transport.js";

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
  const provider = new CodexAppServerAgentClient(
    createTestLogger(),
    {
      command: { mode: "replace", argv: ["codex-must-not-run-in-this-test"] },
    },
    {
      appServerProcess: {
        resolvePrefix: async () => ({ command: "codex", args: [] }),
        spawn: () => appServer.child,
      },
    },
  );
  const internals = provider as unknown as {
    goalsEnabledPromise: Promise<boolean> | null;
    autoReviewEnabledPromise: Promise<boolean> | null;
  };
  internals.goalsEnabledPromise = Promise.resolve(false);
  internals.autoReviewEnabledPromise = Promise.resolve(false);
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

function paginatedClient(pages: Record<string, { ids: string[]; nextCursor: string | null }>) {
  const requested: Array<string | undefined> = [];
  return {
    requested,
    request: async (method: string, params?: unknown) => {
      if (method === "thread/read") return { thread: { historyMode: "paginated" } };
      const { cursor } = params as { cursor?: string };
      requested.push(cursor);
      const page = pages[cursor ?? "first"];
      if (!page) throw new Error(`No page at ${cursor}`);
      return {
        data: page.ids.map((id) => ({ turnId: "turn-1", item: agentItem(id, id) })),
        nextCursor: page.nextCursor,
      };
    },
  };
}

describe("Codex thread history", () => {
  // Each page is a round trip through a shared event loop; on a busy daemon the wait between
  // pages, not Codex, dominated a 141-page read. Overlap the next request with consumption.
  test("requests the next page while the consumer still holds the current one", async () => {
    const client = paginatedClient({
      first: { ids: ["a", "b"], nextCursor: "p2" },
      p2: { ids: ["c"], nextCursor: null },
    });
    const rows = readCodexThreadHistory(client, "thread-1");

    const first = await rows.next();
    expect(first.value?.item).toMatchObject({ id: "a" });
    expect(client.requested).toEqual([undefined, "p2"]);

    const rest: unknown[] = [];
    for await (const row of rows) rest.push(row.item);
    expect(rest).toEqual([
      expect.objectContaining({ id: "b" }),
      expect.objectContaining({ id: "c" }),
    ]);
    expect(client.requested).toEqual([undefined, "p2"]);
  });

  test("a consumer that stops early leaves no unhandled prefetch failure", async () => {
    const client = paginatedClient({ first: { ids: ["a"], nextCursor: "missing" } });
    const rows = readCodexThreadHistory(client, "thread-1");

    expect((await rows.next()).value?.item).toMatchObject({ id: "a" });
    // The prefetched page fails while nobody awaits it, then the consumer stops.
    await new Promise((resolve) => setImmediate(resolve));
    await rows.return(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.requested).toEqual([undefined, "missing"]);
  });

  test("reads the newest native page first and keeps every older item reachable", async () => {
    const requests: { cursor?: string; limit: number; sortDirection: string }[] = [];
    const rows = Array.from({ length: 251 }, (_, index) => ({
      turnId: `turn-${index}`,
      item: agentItem(`answer-${index}`, `${index}`),
    }));
    const client = {
      request: async (method: string, params?: unknown) => {
        if (method === "thread/read") return { thread: { historyMode: "paginated" } };
        const request = params as { cursor?: string; limit: number; sortDirection: string };
        requests.push(request);
        expect(request.sortDirection).toBe("desc");
        const start = Number(request.cursor ?? 0);
        const end = Math.min(start + request.limit, rows.length);
        return {
          data: rows.toReversed().slice(start, end),
          nextCursor: end < rows.length ? String(end) : null,
        };
      },
    };
    const tail = await readCodexThreadHistoryPage(client, "thread", { limit: 100 });
    expect(tail!.rows.map((row) => row.item)).toEqual(rows.slice(151).map((row) => row.item));
    expect(requests).toHaveLength(1);
    const all = [...tail!.rows];
    let cursor = tail!.nextCursor;
    while (cursor) {
      const page = await readCodexThreadHistoryPage(client, "thread", { cursor, limit: 100 });
      all.unshift(...page!.rows);
      cursor = page!.nextCursor;
    }
    expect(all.map((row) => row.item)).toEqual(rows.map((row) => row.item));
    expect(requests).toHaveLength(3);
  });
  test("retries oversized descending pages without advancing the cursor", async () => {
    const requests: Array<{ cursor?: string; limit: number }> = [];
    const page = await readCodexThreadHistoryPage(
      {
        request: async (_method, params) => {
          const request = params as { cursor?: string; limit: number };
          requests.push(request);
          if (request.limit > 12)
            throw new CodexAppServerResponseTooLargeError("thread/items/list", 1024);
          return {
            data: [{ turnId: "turn", item: agentItem("answer", "saved") }],
            nextCursor: "next",
          };
        },
      },
      "thread",
      { cursor: "older", limit: 100 },
    );
    expect(requests.map((request) => request.limit)).toEqual([100, 50, 25, 12]);
    expect(requests.every((request) => request.cursor === "older")).toBe(true);
    expect(page?.nextCursor).toBe("next");
    await expect(
      readCodexThreadHistoryPage(
        {
          request: async () => {
            throw new CodexAppServerResponseTooLargeError("thread/items/list", 1024);
          },
        },
        "thread",
        { cursor: "older", limit: 1 },
      ),
    ).rejects.toThrow("exceeds");
  });

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

  test("a page too big to send retries smaller pages, then warns at the item that cannot fit", async () => {
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
      ...answers.map((answer) => ({
        type: "assistant_message",
        text: answer.text,
        messageId: answer.id,
      })),
      { type: "user_message", text: "Two", messageId: "user-2" },
      {
        type: "notification",
        level: "warning",
        message: "The rest of this Codex thread's history is too large to load.",
      },
    ];
    try {
      expect(timelineItems(await readHistory(session))).toEqual(loaded);
      // Each oversized page retries the same cursor at half the size until it fits.
      expect(
        historyRequests(appServer)
          .filter((request) => request.method === "thread/items/list")
          .map((request) => (request.params as { limit: number }).limit),
      ).toEqual([100, 100, 50, 25, 12, 12, 6, 6, 3, 3, 1, 1]);
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
