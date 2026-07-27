import { describe, expect, it } from "vitest";
import {
  isArchivedAgentSelectable,
  pruneSelectedAgentKeys,
  selectAllArchivedAgentKeys,
  toAgentListKey,
} from "./agent-list-selection";

describe("agent-list-selection", () => {
  it("builds a stable agent key", () => {
    expect(toAgentListKey({ serverId: "host-a", id: "agent-1" })).toBe("host-a:agent-1");
  });

  it("only marks archived agents selectable", () => {
    expect(isArchivedAgentSelectable({ archivedAt: new Date("2026-01-01") })).toBe(true);
    expect(isArchivedAgentSelectable({ archivedAt: null })).toBe(false);
    expect(isArchivedAgentSelectable({})).toBe(false);
  });

  it("selects every archived agent key", () => {
    const keys = selectAllArchivedAgentKeys([
      { serverId: "a", id: "1", archivedAt: new Date() },
      { serverId: "a", id: "2", archivedAt: null },
      { serverId: "b", id: "3", archivedAt: new Date() },
    ]);
    expect([...keys].sort()).toEqual(["a:1", "b:3"]);
  });

  it("prunes keys that are no longer archived/present", () => {
    const next = pruneSelectedAgentKeys(new Set(["a:1", "a:2", "gone"]), [
      { serverId: "a", id: "1", archivedAt: new Date() },
      { serverId: "a", id: "2", archivedAt: null },
    ]);
    expect([...next]).toEqual(["a:1"]);
  });
});
