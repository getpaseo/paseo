import { describe, expect, it } from "vitest";
import type { CommandCenterContribution, CommandCenterRegistrationOwner } from "./contributions";
import { createCommandCenterRegistry } from "./registry";

function action(id: string, rank: number): CommandCenterContribution {
  return {
    id,
    group: "actions",
    groupRank: 0,
    rank,
    keywords: [],
    visibility: "always",
    run: () => undefined,
    presentation: { kind: "action", title: id },
  };
}

function owner(sourceId: string): CommandCenterRegistrationOwner {
  return { sourceId, token: Symbol(sourceId) };
}

describe("Command Center registry", () => {
  it("atomically replaces a source and preserves a no-op snapshot", () => {
    const registry = createCommandCenterRegistry();
    const source = owner("root");
    const first = [action("first", 0)];
    let notifications = 0;
    registry.subscribe(() => {
      notifications += 1;
    });

    registry.replace({ owner: source, contributions: first });
    const snapshot = registry.getSnapshot();
    registry.replace({ owner: source, contributions: first });
    expect(registry.getSnapshot()).toBe(snapshot);
    expect(notifications).toBe(1);

    registry.replace({ owner: source, contributions: [action("second", 0)] });
    expect(registry.getSnapshot().contributions.map((item) => item.id)).toEqual(["root:second"]);
    expect(notifications).toBe(2);
  });

  it("does not let stale cleanup remove a replacement owner", () => {
    const registry = createCommandCenterRegistry();
    const stale = owner("draft:tab");
    const current = owner("draft:tab");
    registry.replace({ owner: stale, contributions: [action("old", 0)] });
    registry.replace({ owner: current, contributions: [action("new", 0)] });

    registry.remove(stale);
    expect(registry.getSnapshot().contributions.map((item) => item.id)).toEqual(["draft:tab:new"]);
    registry.remove(current);
    expect(registry.getSnapshot().contributions).toEqual([]);
  });

  it("orders independently of registration order and rejects duplicate active ids", () => {
    const registry = createCommandCenterRegistry();
    registry.replace({ owner: owner("later"), contributions: [action("z", 2)] });
    registry.replace({ owner: owner("earlier"), contributions: [action("a", 1)] });
    expect(registry.getSnapshot().contributions.map((item) => item.id)).toEqual([
      "earlier:a",
      "later:z",
    ]);

    const duplicateOwner = owner("duplicate");
    expect(() =>
      registry.replace({
        owner: duplicateOwner,
        contributions: [action("same", 0), action("same", 1)],
      }),
    ).toThrow("Duplicate Command Center contribution id: duplicate:same");
  });
});
