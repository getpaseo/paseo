import { describe, expect, it } from "vitest";
import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";
import {
  hasLargeWorkspaceRowAccessory,
  nextLargeRailMemory,
  selectWorkspaceRowAccessory,
} from "./workspace-row-model";

function Glyph() {
  return null;
}

function accessory(
  id: string,
  sequence: number,
  size: EvaluatedWorkspaceRowAccessory["size"] = "status",
): EvaluatedWorkspaceRowAccessory {
  return { id, Component: Glyph, size, sequence };
}

function plugin(serverId: string, workspaceRowAccessories: EvaluatedWorkspaceRowAccessory[]) {
  return { id: "row-fixture", serverId, workspaceRowAccessories } as unknown as InstalledPlugin;
}

const evaluated =
  (...hosts: string[]) =>
  (serverId: string) =>
    hosts.includes(serverId);
const pendingFor = (milliseconds: number) => () => milliseconds;

describe("selectWorkspaceRowAccessory", () => {
  it("picks the most recently registered accessory of the row's host", () => {
    const older = plugin("host", [accessory("first", 1), accessory("second", 4)]);
    const newer = plugin("host", [accessory("third", 3)]);
    const otherHost = plugin("other", [accessory("elsewhere", 9)]);

    const target = selectWorkspaceRowAccessory([older, newer, otherHost], "host");

    expect(target?.plugin).toBe(older);
    expect(target?.accessory.id).toBe("second");
    expect(selectWorkspaceRowAccessory([otherHost], "host")).toBeNull();
  });
});

describe("hasLargeWorkspaceRowAccessory", () => {
  it("is off without plugins or remembered hosts", () => {
    expect(hasLargeWorkspaceRowAccessory([], [], evaluated())).toBe(false);
  });

  it("widens every row when any host has a large accessory", () => {
    expect(
      hasLargeWorkspaceRowAccessory([plugin("host", [accessory("a", 1)])], [], evaluated()),
    ).toBe(false);
    expect(
      hasLargeWorkspaceRowAccessory(
        [plugin("host", [accessory("a", 1)]), plugin("other", [accessory("b", 2, "large")])],
        [],
        evaluated(),
      ),
    ).toBe(true);
  });

  it("holds a remembered large rail until that host's plugins are evaluated", () => {
    expect(hasLargeWorkspaceRowAccessory([], ["host"], evaluated())).toBe(true);
    expect(hasLargeWorkspaceRowAccessory([], ["host"], evaluated("host"))).toBe(false);
  });
});

describe("nextLargeRailMemory", () => {
  it("forgets a host whose evaluated catalog has no large accessory", () => {
    expect(nextLargeRailMemory(["host"], [], evaluated("host"), pendingFor(0))).toEqual([]);
  });

  it("keeps a remembered host while its catalog may still arrive, and only that long", () => {
    const live = plugin("host", [accessory("large", 1, "large")]);

    expect(nextLargeRailMemory(["offline"], [], evaluated(), pendingFor(5_000))).toEqual([
      "offline",
    ]);
    expect(nextLargeRailMemory(["offline"], [], evaluated(), pendingFor(30_000))).toEqual([]);
    expect(nextLargeRailMemory(["offline"], [live], evaluated("host"), pendingFor(30_000))).toEqual(
      ["host"],
    );
  });
});
