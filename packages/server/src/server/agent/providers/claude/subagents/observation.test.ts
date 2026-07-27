import { describe, expect, it } from "vitest";

import { ProviderSubagentStore } from "../../../provider-subagents/store.js";
import { foldSubagentObservations, type SubagentObservation } from "./observation.js";

describe("foldSubagentObservations", () => {
  it("turns a declaration into a running upsert carrying the task", () => {
    expect(
      foldSubagentObservations([
        {
          kind: "declared",
          id: "toolu_1",
          title: "Explore",
          description: "Find subagent title code",
          toolCallId: "toolu_1",
        },
      ]),
    ).toEqual([
      {
        type: "upsert",
        id: "toolu_1",
        status: "running",
        title: "Explore",
        description: "Find subagent title code",
        toolCallId: "toolu_1",
      },
    ]);
  });

  it("emits status alone so the store's sticky merge keeps identity", () => {
    expect(
      foldSubagentObservations([{ kind: "status", id: "toolu_1", status: "completed" }]),
    ).toEqual([{ type: "upsert", id: "toolu_1", status: "completed" }]);
  });

  it("omits absent fields rather than clearing them", () => {
    const [event] = foldSubagentObservations([{ kind: "declared", id: "toolu_1" }]);
    expect(Object.keys(event ?? {}).sort()).toEqual(["id", "status", "type"]);
  });

  it("distinguishes an explicitly null-ish description from an absent one", () => {
    // An empty description is a real observation of "no task text", not "unknown".
    const [event] = foldSubagentObservations([
      { kind: "declared", id: "toolu_1", description: "" },
    ]);
    expect(event).toMatchObject({ description: "" });
  });

  it("passes timeline items through with their timestamp", () => {
    const item = { type: "reasoning", text: "thinking" } as const;
    expect(
      foldSubagentObservations([
        { kind: "timeline", id: "toolu_1", item, timestamp: "2026-07-26T00:00:00.000Z" },
      ]),
    ).toEqual([{ type: "timeline", id: "toolu_1", item, timestamp: "2026-07-26T00:00:00.000Z" }]);
  });

  it("is stateless: folding the same observation twice yields the same event", () => {
    const observation: SubagentObservation = {
      kind: "declared",
      id: "toolu_1",
      title: "Explore",
    };
    expect(foldSubagentObservations([observation])).toEqual(
      foldSubagentObservations([observation]),
    );
  });

  it("accumulates through the store so a later status keeps the declared identity", () => {
    // The property the whole design rests on: sources emit sparse facts, the store merges them.
    const store = new ProviderSubagentStore();
    const events = foldSubagentObservations([
      { kind: "declared", id: "toolu_1", title: "Explore", description: "Find the code" },
      { kind: "status", id: "toolu_1", status: "completed" },
    ]);

    let descriptor = null;
    for (const event of events) {
      const applied = store.apply("parent", "claude", event);
      if (applied.type === "upsert") descriptor = applied.subagent;
    }

    expect(descriptor).toMatchObject({
      id: "toolu_1",
      title: "Explore",
      description: "Find the code",
      status: "completed",
    });
  });
});

describe("runtime and usage observations", () => {
  it("reports a model without asserting a status", () => {
    // task_notification carries usage alongside a terminal status. If a cost report asserted
    // "running", fold order alone could revert a finished subagent.
    const [event] = foldSubagentObservations([
      { kind: "runtime", id: "toolu_1", model: "claude-opus-5" },
    ]);
    expect(event).toEqual({ type: "upsert", id: "toolu_1", model: "claude-opus-5" });
    expect(event).not.toHaveProperty("status");
  });

  it("does not revert a finished subagent when usage arrives after completion", () => {
    const store = new ProviderSubagentStore();
    let descriptor = null;
    for (const event of foldSubagentObservations([
      { kind: "declared", id: "toolu_1", title: "Explore" },
      { kind: "status", id: "toolu_1", status: "completed" },
      { kind: "usage", id: "toolu_1", usage: { totalTokens: 32271, durationMs: 10934 } },
    ])) {
      const applied = store.apply("parent", "claude", event);
      if (applied.type === "upsert") descriptor = applied.subagent;
    }
    expect(descriptor).toMatchObject({
      status: "completed",
      usage: { totalTokens: 32271, durationMs: 10934 },
    });
  });

  it("merges partial usage reports rather than replacing them", () => {
    // task_progress carries tokens and tool count; duration only lands at the end.
    const store = new ProviderSubagentStore();
    let descriptor = null;
    for (const event of foldSubagentObservations([
      { kind: "declared", id: "toolu_1" },
      { kind: "usage", id: "toolu_1", usage: { totalTokens: 16484, toolUses: 1 } },
      { kind: "usage", id: "toolu_1", usage: { durationMs: 10934 } },
    ])) {
      const applied = store.apply("parent", "claude", event);
      if (applied.type === "upsert") descriptor = applied.subagent;
    }
    expect(descriptor).toMatchObject({
      usage: { totalTokens: 16484, toolUses: 1, durationMs: 10934 },
    });
  });

  it("keeps identity when a later runtime observation reports only a model", () => {
    const store = new ProviderSubagentStore();
    let descriptor = null;
    for (const event of foldSubagentObservations([
      { kind: "declared", id: "toolu_1", title: "Explore", description: "Find the code" },
      { kind: "runtime", id: "toolu_1", model: "claude-opus-5" },
    ])) {
      const applied = store.apply("parent", "claude", event);
      if (applied.type === "upsert") descriptor = applied.subagent;
    }
    expect(descriptor).toMatchObject({
      title: "Explore",
      description: "Find the code",
      model: "claude-opus-5",
      status: "running",
    });
  });
});
