import { describe, expect, it } from "vitest";

import { deriveSidebarShortcutAgentKeys, parseSidebarAgentKey } from "./sidebar-shortcuts";

describe("parseSidebarAgentKey", () => {
  it("parses serverId and agentId", () => {
    expect(parseSidebarAgentKey("server:agent")).toEqual({ serverId: "server", agentId: "agent" });
  });

  it("returns null for invalid keys", () => {
    expect(parseSidebarAgentKey("")).toBeNull();
    expect(parseSidebarAgentKey("no-separator")).toBeNull();
    expect(parseSidebarAgentKey(":agent")).toBeNull();
    expect(parseSidebarAgentKey("server:")).toBeNull();
  });
});

describe("deriveSidebarShortcutAgentKeys", () => {
  it("skips collapsed projects and preserves visual order", () => {
    const sections = [
      {
        projectKey: "p1",
        agents: [
          { serverId: "s", id: "a1" },
          { serverId: "s", id: "a2" },
        ],
      },
      {
        projectKey: "p2",
        agents: [
          { serverId: "s", id: "b1" },
          { serverId: "s", id: "b2" },
        ],
      },
    ];

    expect(deriveSidebarShortcutAgentKeys(sections, new Set(["p2"]), 9)).toEqual([
      "s:a1",
      "s:a2",
    ]);
  });

  it("limits to 9", () => {
    const sections = [
      {
        projectKey: "p1",
        agents: Array.from({ length: 20 }, (_, i) => ({ serverId: "s", id: `a${i + 1}` })),
      },
    ];

    expect(deriveSidebarShortcutAgentKeys(sections, new Set(), 9)).toHaveLength(9);
    expect(deriveSidebarShortcutAgentKeys(sections, new Set(), 9)[0]).toBe("s:a1");
    expect(deriveSidebarShortcutAgentKeys(sections, new Set(), 9)[8]).toBe("s:a9");
  });
});

