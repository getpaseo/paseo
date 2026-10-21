import { describe, expect, it } from "vitest";

import { HostPromptQueue } from "./prompt-queue.js";

describe("HostPromptQueue", () => {
  it("keeps every queued prompt and previews them in order", () => {
    const queue = new HostPromptQueue();

    queue.enqueue("agent", { id: "one", text: "first", prompt: "first" });
    queue.enqueue("agent", { id: "two", text: "second", prompt: "second" });

    expect(queue.list("agent")).toEqual([
      { id: "one", text: "first" },
      { id: "two", text: "second" },
    ]);
    expect(queue.shift("agent")?.text).toBe("first");
    expect(queue.list("agent")).toEqual([{ id: "two", text: "second" }]);
  });

  it("removes one prompt without dropping the rest", () => {
    const queue = new HostPromptQueue();
    queue.enqueue("agent", { id: "one", text: "first", prompt: "first" });
    queue.enqueue("agent", { id: "two", text: "second", prompt: "second" });

    expect(queue.remove("agent", "one")?.text).toBe("first");
    expect(queue.remove("agent", "missing")).toBeNull();
    expect(queue.list("agent")).toEqual([{ id: "two", text: "second" }]);
  });

  it("puts a prompt that failed to start back at the front", () => {
    const queue = new HostPromptQueue();
    queue.enqueue("agent", { id: "two", text: "second", prompt: "second" });
    queue.unshift("agent", { id: "one", text: "first", prompt: "first" });

    expect(queue.list("agent")).toEqual([
      { id: "one", text: "first" },
      { id: "two", text: "second" },
    ]);
  });
});
