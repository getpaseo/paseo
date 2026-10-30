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

  test.each(["completed", "interrupted", "running"])(
    "keeps follow-up instructions in replay without applying the %s submission snapshot",
    async (submissionStatus) => {
      const history = await replay([
        collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
        collab("wait", { first: "completed" }),
        { ...collab("sendInput", { first: submissionStatus }), prompt: "Now add tests" },
      ]);
      expect(
        history.flatMap((event) =>
          event.type === "timeline" && event.item.type === "tool_call"
            ? [{ id: event.item.callId, status: event.item.status, detail: event.item.detail }]
            : [],
        ),
      ).toEqual([
        { id: "spawn-first", status: "completed", detail: expect.anything() },
        {
          id: "sendInput",
          status: "completed",
          detail: expect.objectContaining({ description: "Now add tests" }),
        },
      ]);
      expect(
        history.flatMap((event) =>
          event.type === "provider_subagent" && event.event.type === "upsert"
            ? [{ id: event.event.id, status: event.event.status }]
            : [],
        ),
      ).toEqual([{ id: "first", status: "completed" }]);
    },
  );

  test.each([
    ["completed", "closeAgent", "errored", "failed"],
    ["errored", "closeAgent", "completed", "completed"],
    ["completed", "wait", "running", "running"],
    ["completed", "closeAgent", "running", "canceled"],
  ])(
    "replaces the earlier %s outcome after a follow-up and %s result %s",
    async (initialStatus, tool, resultStatus, expected) => {
      const history = await replay([
        collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
        collab("spawnAgent", { second: "pendingInit" }, "spawn-second"),
        {
          ...collab("wait", { first: initialStatus, second: "completed" }),
          status: initialStatus === "errored" ? "failed" : "completed",
        },
        { ...collab("sendInput", { first: "running" }), prompt: "Do more work" },
        {
          ...collab(tool, { first: resultStatus }),
          status: resultStatus === "errored" ? "failed" : "completed",
        },
      ]);
      expect(
        history.flatMap((event) =>
          event.type === "provider_subagent" && event.event.type === "upsert"
            ? [{ id: event.event.id, status: event.event.status }]
            : [],
        ),
      ).toEqual([
        { id: "first", status: expected },
        { id: "second", status: "completed" },
      ]);
      expect(
        history.flatMap((event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.callId === "spawn-first"
            ? [event.item.status]
            : [],
        ),
      ).toEqual([expected]);
    },
  );

  test("keeps the prior outcome when a follow-up submission fails", async () => {
    const history = await replay([
      collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
      collab("wait", { first: "completed" }),
      { ...collab("sendInput", { first: "running" }), status: "failed", prompt: "Do more work" },
      collab("wait", { first: "running" }, "stale-wait"),
    ]);
    expect(
      history.flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "upsert"
          ? [event.event.status]
          : [],
      ),
    ).toEqual(["completed"]);
  });

  test("settles a close card without a registered spawn", async () => {
    const history = await replay([collab("closeAgent", { external: "running" })]);
    expect(
      history.flatMap((event) =>
        event.type === "timeline" && event.item.type === "tool_call"
          ? [{ id: event.item.callId, status: event.item.status }]
          : [],
      ),
    ).toEqual([{ id: "closeAgent", status: "canceled" }]);
  });

  test.each(["notFound", "errored"])(
    "preserves completion and shows a failed resume reporting %s",
    async (status) => {
      const history = await replay([
        collab("spawnAgent", { first: "pendingInit" }, "spawn-first"),
        collab("wait", { first: "completed" }),
        collab("closeAgent", { first: "completed" }),
        { ...collab("resumeAgent", { first: status }), status: "failed" },
      ]);
      expect(
        history.flatMap((event) =>
          event.type === "provider_subagent" && event.event.type === "upsert"
            ? [event.event.status]
            : [],
        ),
      ).toEqual(["completed"]);
      expect(
        history.flatMap((event) =>
          event.type === "timeline" && event.item.type === "tool_call"
            ? [{ id: event.item.callId, status: event.item.status }]
            : [],
        ),
      ).toEqual([
        { id: "spawn-first", status: "completed" },
        { id: "resumeAgent", status: "failed" },
      ]);
    },
  );

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
      notify("item/completed", collab("wait", { second: "completed" }, "wait-second"));
      appServer.completeTurn();
      await result;
      expect([...statuses]).toEqual([["first", "completed"]]);
      expect([...cards]).toEqual([
        ["spawn-first", "completed"],
        ["mixed-wait", "completed"],
        ["wait-second", "completed"],
      ]);
    } finally {
      await session.close();
      appServer.assertNoErrors();
    }
  });

  test.each(["completed", "interrupted", "running"])(
    "keeps a live follow-up running despite a late %s sendInput snapshot",
    async (submissionStatus) => {
      const appServer = createFakeCodexAppServer();
      const session = new CodexAppServerAgentSession(
        { provider: "codex", cwd: process.cwd(), modeId: "full-access" },
        null,
        createTestLogger(),
        async () => appServer.child,
      );
      const statuses = new Map<string, string>();
      const timelineCards = new Map<string, { status: string; detail: unknown }>();
      let parentMessage = "";
      session.subscribe((event) => {
        if (event.type === "provider_subagent" && event.event.type === "upsert") {
          statuses.set(event.event.id, event.event.status);
        }
        if (event.type === "timeline" && event.item.type === "tool_call") {
          timelineCards.set(event.item.callId, {
            status: event.item.status,
            detail: event.item.detail,
          });
        }
        if (event.type === "timeline" && event.item.type === "assistant_message") {
          parentMessage = event.item.text;
        }
      });
      function complete(tool: string, states: Record<string, string>, id = tool) {
        const item = {
          ...collab(tool, states, id),
          ...(tool === "sendInput" ? { prompt: "Now add tests" } : {}),
        };
        if (tool !== "spawnAgent") {
          appServer.child.stdout.write(
            `${JSON.stringify({
              method: "item/started",
              params: {
                threadId: "thread-1",
                item: { ...item, status: "inProgress", agentsStates: {} },
              },
            })}\n`,
          );
        }
        appServer.child.stdout.write(
          `${JSON.stringify({
            method: "item/completed",
            params: { threadId: "thread-1", item },
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
        appServer.startsTurn({ threadId: "first", turnId: "follow-up" });
        await vi.waitFor(() => expect(statuses.get("first")).toBe("running"));
        complete("sendInput", { first: submissionStatus });
        appServer.says({ threadId: "thread-1", text: "Follow-up submitted." });
        await vi.waitFor(() => expect(parentMessage).toBe("Follow-up submitted."));
        expect(statuses.get("first")).toBe("running");
        expect([...timelineCards.keys()]).toEqual(["spawn-first", "spawn-second", "sendInput"]);
        expect(timelineCards.get("sendInput")).toEqual({
          status: "completed",
          detail: expect.objectContaining({ description: "Now add tests" }),
        });
        // Only the child's completion settles the follow-up.
        appServer.completeTurn({ threadId: "first" });
        await vi.waitFor(() => expect(statuses.get("first")).toBe("completed"));
      } finally {
        await session.close();
        appServer.assertNoErrors();
      }
    },
  );
});
