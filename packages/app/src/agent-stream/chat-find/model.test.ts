import { expect, it } from "vitest";
import { hydrateStreamState, type StreamItem } from "@/types/stream";
import { ChatFindModel, type ChatFindOperations } from "./model";

function response(locations: Array<{ seq: number; role: "user" | "assistant"; count?: number }>) {
  return {
    agentId: "agent",
    requestId: "request",
    epoch: "epoch",
    locations,
    nextCursor: null,
    error: null,
  };
}
function message(seq: number, text = "target"): StreamItem {
  return {
    id: `row-${seq}`,
    kind: "assistant_message",
    text,
    timestamp: new Date(0),
    timelineCursor: { epoch: "epoch", seq, anchorSeq: seq },
  };
}

it("loads an older location and searches a response merged across suppressed tasks once", async () => {
  const source = [
    { type: "assistant_message" as const, text: "first **target** " },
    {
      type: "tool_call" as const,
      callId: "task",
      name: "TaskCreate",
      status: "completed" as const,
      detail: { type: "unknown" as const, input: {}, output: null },
      error: null,
    },
    { type: "assistant_message" as const, text: "second target" },
  ];
  const history = hydrateStreamState(
    source.map((item, index) => ({
      event: { type: "timeline" as const, provider: "claude" as const, item },
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch", seq: index + 1, anchorSeq: index + 1 },
    })),
    { source: "canonical" },
  );
  expect(history).toHaveLength(1);
  const loaded: number[] = [];
  const revealed: number[] = [];
  const model = new ChatFindModel({
    async search() {
      return response([
        { seq: 1, role: "assistant" },
        { seq: 3, role: "assistant" },
      ]);
    },
    async load(_epoch, seq) {
      loaded.push(seq);
      model.updateHistory("epoch", history, null);
    },
    async reveal(_id, _query, occurrence) {
      revealed.push(occurrence);
      return { count: 2, occurrence: occurrence < 0 ? 1 : occurrence };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    model.next();
    await expect.poll(() => model.getSnapshot().occurrence).toBe(1);
    model.next();
    await expect.poll(() => revealed).toEqual([0, 1, 0]);
    model.previous();
    await expect.poll(() => model.getSnapshot().occurrence).toBe(1);
    expect(loaded).toEqual([1]);
  } finally {
    model.close();
  }
});

it("skips a source-only candidate and highlights a displayed match", async () => {
  const revealed: string[] = [];
  const model = new ChatFindModel({
    async search() {
      return response([
        { seq: 1, role: "assistant" },
        { seq: 2, role: "assistant" },
      ]);
    },
    async load() {
      throw new Error("Already loaded");
    },
    async reveal(id) {
      revealed.push(id);
      return { count: id === "row-1" ? 0 : 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1), message(2)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().selectedItemId).toBe("row-2");
    expect(revealed).toEqual(["row-1", "row-2"]);
    expect(model.getSnapshot().phase).toBe("ready");
  } finally {
    model.close();
  }
});

it("ignores replies after closing and does not navigate", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const calls: string[] = [];
  const model = new ChatFindModel({
    search() {
      calls.push("search");
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    async load() {
      calls.push("load");
    },
    async reveal() {
      calls.push("reveal");
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  model.updateHistory("epoch", [message(1)], null);
  model.open();
  model.setQuery("target");
  await expect.poll(() => calls).toEqual(["search"]);
  model.close();
  finish(response([{ seq: 1, role: "assistant" }]));
  await Promise.resolve();
  expect(calls).toEqual(["search"]);
  expect(model.getSnapshot()).toMatchObject({ open: false, phase: "idle" });
});

it("retains a failed search for retry and distinguishes failure from zero matches", async () => {
  let disconnected = true;
  const operations: ChatFindOperations = {
    async search() {
      if (disconnected) throw new Error("Host disconnected");
      return response([]);
    },
    async load() {},
    async reveal() {
      return { count: 0, occurrence: 0 };
    },
    clear() {},
  };
  const model = new ChatFindModel(operations);
  try {
    model.updateHistory("epoch", [], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("error");
    expect(model.getSnapshot().failure).toBe("connection");
    disconnected = false;
    model.retry();
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({ count: 0, failure: null });
  } finally {
    model.close();
  }
});

// `load` is a host RPC like `search`, so its failure is a connection failure and the
// widget must say so rather than blaming the reveal.
it("reports a failed timeline load as a connection failure", async () => {
  const model = new ChatFindModel({
    async search() {
      return response([{ seq: 1, role: "assistant" }]);
    },
    async load() {
      throw new Error("Host disconnected");
    },
    async reveal() {
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("error");
    expect(model.getSnapshot().failure).toBe("connection");
  } finally {
    model.close();
  }
});

it("reports a search result that outlived its epoch as a changed history", async () => {
  const model = new ChatFindModel({
    async search() {
      return response([{ seq: 1, role: "assistant" }]);
    },
    async load() {},
    async reveal() {
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    model.updateHistory("epoch-2", [message(1)], null);
    expect(model.getSnapshot()).toMatchObject({ phase: "error", failure: "historyChanged" });
  } finally {
    model.close();
  }
});

it("reports results that a rewind took messages from as a changed history", async () => {
  const model = new ChatFindModel({
    async search() {
      return response([{ seq: 2, role: "assistant" }]);
    },
    async load() {},
    async reveal() {
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1), message(2)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({ selectedItemId: "row-2", count: 1 });
    // Another client rewinds the turn holding the match; the epoch stays.
    model.updateHistory("epoch", [message(1)], 3);
    expect(model.getSnapshot()).toMatchObject({
      phase: "error",
      failure: "historyChanged",
      selectedItemId: null,
    });
  } finally {
    model.close();
  }
});

it("stops a search still receiving pages when a rewind lands between them", async () => {
  let pages = 0;
  let releaseSecondPage!: () => void;
  const secondPage = new Promise<void>((resolve) => {
    releaseSecondPage = resolve;
  });
  const model = new ChatFindModel({
    async search(_query, cursor) {
      pages += 1;
      if (cursor === undefined)
        return { ...response([{ seq: 2, role: "assistant" }]), nextCursor: 2 };
      await secondPage;
      return response([{ seq: 1, role: "assistant" }]);
    },
    async load() {},
    async reveal() {
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1), message(2)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => pages).toBe(2);
    model.updateHistory("epoch", [message(1)], 3);
    releaseSecondPage();
    await expect.poll(() => model.getSnapshot().failure).toBe("historyChanged");
    expect(model.getSnapshot()).toMatchObject({ phase: "error", selectedItemId: null });
  } finally {
    model.close();
  }
});

it.each([
  ["Next", "next"],
  ["Previous", "previous"],
] as const)("reports a rewind after %s as a changed history", async (_label, step) => {
  const model = new ChatFindModel({
    async search() {
      return response([
        { seq: 1, role: "assistant" },
        { seq: 2, role: "assistant" },
      ]);
    },
    async load() {},
    async reveal() {
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1), message(2)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    model[step]();
    await expect.poll(() => model.getSnapshot().selectedItemId).toBe("row-2");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    model.updateHistory("epoch", [message(1)], 3);
    expect(model.getSnapshot()).toMatchObject({
      phase: "error",
      failure: "historyChanged",
      selectedItemId: null,
    });
  } finally {
    model.close();
  }
});

it("stops a pending Next when a rewind lands before it reveals", async () => {
  let reveals = 0;
  let revealSecond!: () => void;
  const secondReveal = new Promise<void>((resolve) => {
    revealSecond = resolve;
  });
  const model = new ChatFindModel({
    async search() {
      return response([
        { seq: 1, role: "assistant" },
        { seq: 2, role: "assistant" },
      ]);
    },
    async load() {},
    async reveal() {
      reveals += 1;
      if (reveals > 1) await secondReveal;
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1), message(2)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    model.next();
    await expect.poll(() => reveals).toBe(2);
    model.updateHistory("epoch", [message(1)], 3);
    revealSecond();
    await expect.poll(() => model.getSnapshot().failure).toBe("historyChanged");
    expect(model.getSnapshot()).toMatchObject({ phase: "error", selectedItemId: null });
  } finally {
    model.close();
  }
});

it("can load a search location before the initial chat history has arrived", async () => {
  const model = new ChatFindModel({
    async search() {
      return response([{ seq: 1, role: "assistant" }]);
    },
    async load() {
      model.updateHistory("epoch", [message(1)], null);
    },
    async reveal() {
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory(null, [], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({ selectedItemId: "row-1", count: 1, failure: null });
  } finally {
    model.close();
  }
});

// The scope of the search is the whole chat, so the position spans every located
// message: the host's estimate until a message is on screen, the rendered count after.
it("reports the position across the whole chat and corrects it with rendered counts", async () => {
  const model = new ChatFindModel({
    async search() {
      return response([
        { seq: 1, role: "assistant", count: 2 },
        { seq: 2, role: "assistant", count: 3 },
      ]);
    },
    async load() {},
    async reveal(id, _query, occurrence) {
      const count = id === "row-1" ? 2 : 1;
      return { count, occurrence: occurrence < 0 ? count - 1 : occurrence };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1), message(2)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({ selectedItemId: "row-1", occurrence: 0, count: 5 });
    model.next();
    await expect.poll(() => model.getSnapshot().occurrence).toBe(1);
    expect(model.getSnapshot().count).toBe(5);
    model.next();
    await expect.poll(() => model.getSnapshot().selectedItemId).toBe("row-2");
    expect(model.getSnapshot()).toMatchObject({ occurrence: 2, count: 3 });
    model.previous();
    await expect.poll(() => model.getSnapshot().selectedItemId).toBe("row-1");
    expect(model.getSnapshot()).toMatchObject({ occurrence: 1, count: 3 });
  } finally {
    model.close();
  }
});

// COMPAT(timelineSearchCount): a host that reports no counts is worth one match per
// located message until a reveal replaces the estimate with the rendered count.
it("counts one match per message from a host that reports no counts", async () => {
  const model = new ChatFindModel({
    async search() {
      return response([
        { seq: 1, role: "assistant" },
        { seq: 2, role: "assistant" },
      ]);
    },
    async load() {},
    async reveal(id, _query, occurrence) {
      const count = id === "row-1" ? 2 : 1;
      return { count, occurrence: occurrence < 0 ? count - 1 : occurrence };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", [message(1), message(2)], null);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({ selectedItemId: "row-1", occurrence: 0, count: 3 });
    model.next();
    await expect.poll(() => model.getSnapshot().occurrence).toBe(1);
    model.next();
    await expect.poll(() => model.getSnapshot().selectedItemId).toBe("row-2");
    expect(model.getSnapshot()).toMatchObject({ occurrence: 2, count: 3 });
  } finally {
    model.close();
  }
});
