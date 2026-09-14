import { describe, expect, test } from "vitest";
import { PluginSubagentSources } from "./reporters.js";
import { ProviderSubagentStore, type ProviderSubagentStoreEvent } from "./store.js";

function setup() {
  const store = new ProviderSubagentStore();
  const events: ProviderSubagentStoreEvent[] = [];
  const sources = new PluginSubagentSources(store, (event) => events.push(event));
  const parent = { id: "parent", provider: "pi", isCurrent: () => true };
  return { store, events, sources, parent };
}

describe("plugin subagent sources", () => {
  test("isolates native children and each reporter, while retaining the parent's provider", async () => {
    const { store, sources, parent } = setup();
    const first = sources.open("first", parent);
    const second = sources.open("second", parent);
    store.apply(parent.id, "pi", { type: "upsert", id: "child" });
    await first.report({ type: "upsert", id: "child", title: "First", status: "running" });
    await second.report({ type: "upsert", id: "child", title: "Second", status: "completed" });
    const [native, one, two] = store.list(parent.id);
    expect(native?.id).toBe("child");
    expect(one).toMatchObject({ provider: "pi", parentAgentId: "parent", title: "First" });
    expect(two).toMatchObject({ provider: "pi", parentAgentId: "parent", title: "Second" });
    expect(one?.id).toMatch(/^plugin\/first\//);
    expect(two?.id).toMatch(/^plugin\/second\//);
    await first.close();
    await first.close();
    expect(store.list(parent.id)).toEqual([native, two]);
    await expect(first.report({ type: "upsert", id: "late" })).rejects.toThrow("closed");
  });

  test("requires descriptors, namespaces nested parents, rejects cycles, and removes descendants", async () => {
    const { store, sources, parent } = setup();
    const reporter = sources.open("plugin", parent);
    await expect(
      reporter.report({
        type: "timeline",
        id: "child",
        item: { type: "assistant_message", text: "Missing" },
      }),
    ).rejects.toThrow("Declare");
    await expect(
      reporter.report({ type: "upsert", id: "nested", parentSubagentId: "child" }),
    ).rejects.toThrow("declared");
    await reporter.report({ type: "upsert", id: "child", status: "completed", title: "Child" });
    await reporter.report({ type: "upsert", id: "nested", parentSubagentId: "child" });
    await reporter.report({ type: "upsert", id: "child", subtitle: "Updated" });
    await expect(
      reporter.report({ type: "upsert", id: "child", parentSubagentId: "nested" }),
    ).rejects.toThrow("cycle");
    const [child, nested] = store.list(parent.id);
    expect(child).toMatchObject({ status: "completed", title: "Child", subtitle: "Updated" });
    expect(nested?.parentSubagentId).toBe(child?.id);
    await reporter.report({
      type: "timeline",
      id: "nested",
      item: { type: "assistant_message", text: "Found it" },
    });
    expect(store.fetchTimeline(parent.id, nested!.id).rows[0]?.item).toEqual({
      type: "assistant_message",
      text: "Found it",
    });
    await reporter.report({ type: "remove", id: "child" });
    await reporter.report({ type: "remove", id: "child" });
    expect(store.list(parent.id)).toEqual([]);
    expect(() => store.fetchTimeline(parent.id, nested!.id)).toThrow("Unknown agent");
  });

  test("parent invalidation removes reports without inventing worker cancellation", async () => {
    const { store, events, sources, parent } = setup();
    const reporter = sources.open("plugin", parent);
    await reporter.report({ type: "upsert", id: "child", status: "running" });
    const id = store.list(parent.id)[0]!.id;
    sources.deleteParent(parent.id);
    await reporter.close();
    await expect(reporter.report({ type: "upsert", id: "child" })).rejects.toThrow("closed");
    expect(events).toEqual([
      { type: "upsert", subagent: expect.objectContaining({ status: "running" }) },
      { type: "remove", parentAgentId: parent.id, subagentId: id },
    ]);
    expect(store.list(parent.id)).toEqual([]);
  });
});
