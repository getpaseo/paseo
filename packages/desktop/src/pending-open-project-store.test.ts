import { describe, expect, it } from "vitest";

import { PendingOpenProjectStore } from "./pending-open-project-store";

describe("PendingOpenProjectStore", () => {
  it("stores pending paths per window and consumes them independently", () => {
    const store = new PendingOpenProjectStore();

    store.set(101, "/tmp/project-a");
    store.set(202, "/tmp/project-b");

    expect(store.take(101)).toBe("/tmp/project-a");
    expect(store.take(202)).toBe("/tmp/project-b");
  });

  it("clears a pending path after it is consumed", () => {
    const store = new PendingOpenProjectStore();

    store.set(101, "/tmp/project-a");

    expect(store.take(101)).toBe("/tmp/project-a");
    expect(store.take(101)).toBeNull();
  });

  it("ignores empty and whitespace-only paths", () => {
    const store = new PendingOpenProjectStore();

    store.set(101, "   ");

    expect(store.take(101)).toBeNull();
  });
});
