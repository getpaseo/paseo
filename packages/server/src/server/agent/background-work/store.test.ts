import { describe, expect, test } from "vitest";

import { AgentBackgroundWorkStore } from "./store.js";

const T0 = "2026-10-06T10:00:00.000Z";
const T1 = "2026-10-06T10:05:00.000Z";

describe("AgentBackgroundWorkStore", () => {
  test("stamps new items and keeps their start time across replacements", () => {
    const store = new AgentBackgroundWorkStore();

    expect(
      store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: "sleep 20" }], T0),
    ).toEqual([{ id: "bash-1", kind: "shell", description: "sleep 20", startedAt: T0 }]);

    expect(
      store.apply(
        "agent-a",
        [
          { id: "bash-1", kind: "shell", description: "sleep 20" },
          { id: "task-1", kind: "other", description: null },
        ],
        T1,
      ),
    ).toEqual([
      { id: "bash-1", kind: "shell", description: "sleep 20", startedAt: T0 },
      { id: "task-1", kind: "other", description: null, startedAt: T1 },
    ]);
  });

  test("returns null when the replacement changes nothing", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: "sleep 20" }], T0);

    expect(
      store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: "sleep 20" }], T1),
    ).toBeNull();
    expect(store.apply("agent-b", [], T1)).toBeNull();
  });

  test("keeps the first occurrence of a duplicated id", () => {
    const store = new AgentBackgroundWorkStore();

    expect(
      store.apply(
        "agent-a",
        [
          { id: "bash-1", kind: "shell", description: "first" },
          { id: "bash-1", kind: "shell", description: "second" },
        ],
        T0,
      ),
    ).toEqual([{ id: "bash-1", kind: "shell", description: "first", startedAt: T0 }]);
  });

  test("scopes lists per agent and clears one agent", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: null }], T0);
    store.apply("agent-b", [{ id: "bash-2", kind: "shell", description: null }], T0);

    expect(store.clear("agent-a")).toEqual([]);
    expect(store.clear("agent-a")).toBeNull();
    expect(store.list("agent-a")).toEqual([]);
    expect(store.list("agent-b")).toHaveLength(1);
  });

  test("keeps only the wire fields of each input", () => {
    const store = new AgentBackgroundWorkStore();
    const input = { id: "bash-1", kind: "shell", description: null, pid: 4242 };

    expect(store.apply("agent-a", [input], T0)).toEqual([
      { id: "bash-1", kind: "shell", description: null, startedAt: T0 },
    ]);
  });

  test("list returns a copy", () => {
    const store = new AgentBackgroundWorkStore();
    store.apply("agent-a", [{ id: "bash-1", kind: "shell", description: null }], T0);

    store.list("agent-a").pop();

    expect(store.list("agent-a")).toHaveLength(1);
  });
});
