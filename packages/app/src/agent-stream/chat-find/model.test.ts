import { expect, it } from "vitest";
import { hydrateStreamState, type StreamItem } from "@/types/stream";
import { ChatFindModel, type ChatFindOperations } from "./model";

function response(locations: Array<{ seq: number; role: "user" | "assistant" }>) {
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
    timelineCursor: { epoch: "epoch", seq },
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
      timelineCursor: { epoch: "epoch", seq: index + 1 },
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
      model.updateHistory("epoch", history);
    },
    async reveal(_id, _query, occurrence) {
      revealed.push(occurrence);
      return { count: 2, occurrence: occurrence < 0 ? 1 : occurrence };
    },
    clear() {},
  });
  try {
    model.updateHistory("epoch", []);
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
    model.updateHistory("epoch", [message(1), message(2)]);
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
  model.updateHistory("epoch", [message(1)]);
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
    model.updateHistory("epoch", []);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("error");
    expect(model.getSnapshot().error).toBe("Host disconnected");
    disconnected = false;
    model.retry();
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({ count: 0, error: null });
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
      model.updateHistory("epoch", [message(1)]);
    },
    async reveal() {
      return { count: 1, occurrence: 0 };
    },
    clear() {},
  });
  try {
    model.updateHistory(null, []);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({ selectedItemId: "row-1", count: 1, error: null });
  } finally {
    model.close();
  }
});
