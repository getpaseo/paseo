import { describe, expect, test, vi } from "vitest";
import { CodexAppServerAgentSession } from "../codex-app-server-agent.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { createFakeCodexAppServer } from "./test-utils/fake-app-server.js";

function collab(tool: string, states: Record<string, string>, id = tool) {
  return {
    type: "collabAgentToolCall",
    id,
    tool,
    status: "completed",
    prompt: tool === "spawnAgent" ? "Reply with a short result." : null,
    receiverThreadIds: Object.keys(states),
    agentsStates: Object.fromEntries(
      Object.entries(states).map(([threadId, status]) => [threadId, { status }]),
    ),
  };
}

async function replay(items: unknown[]) {
  const appServer = createFakeCodexAppServer({
    "thread/read": (params) => ({
      thread: {
        turns: [
          {
            items: (params as { threadId: string }).threadId === "parent" ? items : [],
          },
        ],
      },
    }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "full-access" },
    { sessionId: "parent" },
    createTestLogger(),
    async () => appServer.child,
    {},
    false,
    false,
    false,
    undefined,
    "history",
  );
  try {
    await session.connect();
    return await Array.fromAsync(session.streamHistory());
  } finally {
    await session.close();
    appServer.assertNoErrors();
  }
}

describe("Codex collaboration history", () => {
  test("restores completed children from nullable wait and close results", async () => {
    const history = await replay([
      collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
      collab("spawnAgent", { second: "pendingInit" }, "spawn-second"),
      collab("wait", { first: "completed" }, "wait-first"),
      collab("wait", { second: "completed" }, "wait-second"),
      collab("closeAgent", { first: "completed" }, "close-first"),
      collab("closeAgent", { second: "completed" }, "close-second"),
    ]);
    expect(
      history.flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "upsert"
          ? [{ id: event.event.id, status: event.event.status }]
          : [],
      ),
    ).toEqual([
      { id: "first", status: "completed" },
      { id: "second", status: "completed" },
    ]);
  });

  test("stops counting a child closed while running", async () => {
    const history = await replay([
      collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
      collab("closeAgent", { first: "running" }),
    ]);
    expect(
      history.flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "upsert"
          ? [{ id: event.event.id, status: event.event.status }]
          : [],
      ),
    ).toEqual([{ id: "first", status: "canceled" }]);
  });

  test.each(["wait", "closeAgent"])(
    "restores an errored child as failed after %s",
    async (tool) => {
      const history = await replay([
        collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
        { ...collab(tool, { first: "errored" }), status: "failed" },
      ]);
      expect(
        history.flatMap((event) =>
          event.type === "provider_subagent" && event.event.type === "upsert"
            ? [{ id: event.event.id, status: event.event.status }]
            : [],
        ),
      ).toEqual([{ id: "first", status: "failed" }]);
      expect(
        history.flatMap((event) =>
          event.type === "timeline" && event.item.type === "tool_call"
            ? [{ id: event.item.callId, status: event.item.status, error: event.item.error }]
            : [],
        ),
      ).toEqual([{ id: "spawn-first", status: "failed", error: { message: "Sub-agent failed" } }]);
    },
  );

  test.each(["wait", "closeAgent"])(
    "settles a live errored child as failed after %s",
    async (tool) => {
      const appServer = createFakeCodexAppServer();
      const session = new CodexAppServerAgentSession(
        { provider: "codex", cwd: process.cwd(), modeId: "full-access" },
        null,
        createTestLogger(),
        async () => appServer.child,
      );
      const statuses = new Map<string, string>();
      const cards = new Map<string, { status: string; error: unknown }>();
      session.subscribe((event) => {
        if (event.type === "provider_subagent" && event.event.type === "upsert") {
          statuses.set(event.event.id, event.event.status);
        }
        if (event.type === "timeline" && event.item.type === "tool_call") {
          cards.set(event.item.callId, { status: event.item.status, error: event.item.error });
        }
      });
      function notify(method: string, item: ReturnType<typeof collab>) {
        appServer.child.stdout.write(
          `${JSON.stringify({ method, params: { threadId: "thread-1", item } })}\n`,
        );
      }
      try {
        const result = session.run("Delegate the work.");
        await appServer.waitForTurnStart();
        notify("item/completed", collab("spawnAgent", { first: "pendingInit" }, "spawn-first"));
        notify("item/started", {
          ...collab(tool, { first: "errored" }),
          status: "inProgress",
          agentsStates: {},
        });
        notify("item/completed", { ...collab(tool, { first: "errored" }), status: "failed" });
        appServer.completeTurn();
        await result;
        expect([...statuses]).toEqual([["first", "failed"]]);
        expect([...cards]).toEqual([
          ["spawn-first", { status: "failed", error: { message: "Sub-agent failed" } }],
        ]);
      } finally {
        await session.close();
        appServer.assertNoErrors();
      }
    },
  );

  test("preserves completion when a close carries an older running snapshot", async () => {
    const history = await replay([
      collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
      collab("wait", { first: "completed" }),
      collab("closeAgent", { first: "running" }),
    ]);
    expect(
      history.flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "upsert"
          ? [{ id: event.event.id, status: event.event.status }]
          : [],
      ),
    ).toEqual([{ id: "first", status: "completed" }]);
  });

  test.each([
    ["shutdown", "canceled"],
    ["notFound", "failed"],
  ])("restores a %s child as %s and preserves its running sibling", async (status, expected) => {
    const history = await replay([
      collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
      collab("spawnAgent", { second: "pendingInit" }, "spawn-second"),
      collab("closeAgent", { first: status }),
    ]);
    expect(
      history.flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "upsert"
          ? [{ id: event.event.id, status: event.event.status }]
          : [],
      ),
    ).toEqual([
      { id: "first", status: expected },
      { id: "second", status: "running" },
    ]);
  });

  test("settles a rendered live wait when its completion lists only the finished receiver", async () => {
    const appServer = createFakeCodexAppServer();
    const session = new CodexAppServerAgentSession(
      { provider: "codex", cwd: process.cwd(), modeId: "full-access" },
      null,
      createTestLogger(),
      async () => appServer.child,
    );
    const cards = new Map<string, string>();
    const statuses = new Map<string, string>();
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "tool_call") {
        cards.set(event.item.callId, event.item.status);
      }
      if (event.type === "provider_subagent" && event.event.type === "upsert") {
        statuses.set(event.event.id, event.event.status);
      }
    });
    function notify(method: string, item: ReturnType<typeof collab>) {
      appServer.child.stdout.write(
        `${JSON.stringify({ method, params: { threadId: "thread-1", item } })}\n`,
      );
    }
    try {
      const result = session.run("Wait for the children.");
      await appServer.waitForTurnStart();
      notify("item/completed", collab("spawnAgent", { first: "pendingInit" }, "spawn-first"));
      notify("item/started", {
        ...collab("wait", { first: "running", second: "running" }, "mixed-wait"),
        status: "inProgress",
        agentsStates: {},
      });
      await vi.waitFor(() => expect(cards.get("mixed-wait")).toBe("running"));
      notify("item/completed", collab("wait", { first: "completed" }, "mixed-wait"));
      appServer.completeTurn();
      await result;
      expect([...cards]).toEqual([
        ["spawn-first", "completed"],
        ["mixed-wait", "completed"],
      ]);
      expect(statuses.get("first")).toBe("completed");
    } finally {
      await session.close();
      appServer.assertNoErrors();
    }
  });

  test("keeps completed live children settled until an explicit follow-up", async () => {
    const appServer = createFakeCodexAppServer();
    const session = new CodexAppServerAgentSession(
      { provider: "codex", cwd: process.cwd(), modeId: "full-access" },
      null,
      createTestLogger(),
      async () => appServer.child,
    );
    const statuses = new Map<string, string>();
    const timelineCallIds = new Set<string>();
    session.subscribe((event) => {
      if (event.type === "provider_subagent" && event.event.type === "upsert") {
        statuses.set(event.event.id, event.event.status);
      }
      if (event.type === "timeline" && event.item.type === "tool_call") {
        timelineCallIds.add(event.item.callId);
      }
    });
    function complete(tool: string, states: Record<string, string>, id = tool) {
      if (tool !== "spawnAgent") {
        appServer.child.stdout.write(
          `${JSON.stringify({
            method: "item/started",
            params: {
              threadId: "thread-1",
              item: { ...collab(tool, states, id), status: "inProgress", agentsStates: {} },
            },
          })}\n`,
        );
      }
      appServer.child.stdout.write(
        `${JSON.stringify({
          method: "item/completed",
          params: { threadId: "thread-1", item: collab(tool, states, id) },
        })}\n`,
      );
    }
    try {
      const result = session.run("Delegate the work.");
      await appServer.waitForTurnStart();
      complete("spawnAgent", { first: "pendingInit" }, "spawn-first");
      complete("spawnAgent", { second: "pendingInit" }, "spawn-second");
      complete("wait", { first: "completed", second: "running" });
      await vi.waitFor(() => {
        expect(statuses.get("first")).toBe("completed");
        expect(statuses.get("second")).toBe("running");
      });
      complete("closeAgent", { first: "shutdown" });
      complete("wait", { first: "running" }, "stale-wait");
      appServer.says({ threadId: "thread-1", text: "Still waiting." });
      appServer.completeTurn();
      await result;
      expect(statuses.get("first")).toBe("completed");
      complete("sendInput", { first: "running" });
      await vi.waitFor(() => expect(statuses.get("first")).toBe("running"));
      expect([...timelineCallIds]).toEqual(["spawn-first", "spawn-second"]);
    } finally {
      await session.close();
      appServer.assertNoErrors();
    }
  });
});
