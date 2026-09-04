import { describe, expect, it } from "vitest";
import {
  collectProjectGroups,
  connectedProjectGroupClient,
  getProjectGroupReadiness,
  normalizeProjectGroupName,
  setProjectGroupOnHosts,
} from "./index";

function client_(record: Array<{ projectId: string; group: string | null }>, fail = false) {
  return {
    setProjectGroup: async (projectId: string, group: string | null) => {
      if (fail) throw new Error("boom");
      record.push({ projectId, group });
      return { group };
    },
  };
}

describe("getProjectGroupReadiness", () => {
  it("targets every host when all of them support groups", () => {
    const readiness = getProjectGroupReadiness({
      project: {
        hosts: [
          { serverId: "a", projectId: "p1" },
          { serverId: "b", projectId: "p2" },
        ],
      },
      supportsProjectGroups: () => true,
    });
    expect(readiness).toEqual({
      kind: "ready",
      targets: [
        { serverId: "a", projectId: "p1" },
        { serverId: "b", projectId: "p2" },
      ],
    });
  });

  it("names the hosts that need an update instead of writing to the rest", () => {
    const readiness = getProjectGroupReadiness({
      project: {
        hosts: [
          { serverId: "a", projectId: "p1" },
          { serverId: "b", projectId: "p2" },
        ],
      },
      supportsProjectGroups: (serverId) => serverId === "a",
    });
    expect(readiness).toEqual({ kind: "needs_host_update", serverIds: ["b"] });
  });
});

describe("setProjectGroupOnHosts", () => {
  it("refuses to start while any host is disconnected", async () => {
    const writes: Array<{ projectId: string; group: string | null }> = [];
    const outcome = await setProjectGroupOnHosts({
      targets: [
        { serverId: "a", projectId: "p1" },
        { serverId: "b", projectId: "p2" },
      ],
      group: "Client X",
      getClient: (serverId) => (serverId === "a" ? client_(writes) : null),
    });
    expect(outcome).toEqual({ kind: "host_disconnected", serverIds: ["b"] });
    expect(writes).toEqual([]);
  });

  it("writes the group to every host and reports them", async () => {
    const writes: Array<{ projectId: string; group: string | null }> = [];
    const outcome = await setProjectGroupOnHosts({
      targets: [
        { serverId: "a", projectId: "p1" },
        { serverId: "b", projectId: "p2" },
      ],
      group: "Client X",
      getClient: () => client_(writes),
    });
    expect(outcome).toEqual({ kind: "applied", serverIds: ["a", "b"] });
    expect(writes).toEqual([
      { projectId: "p1", group: "Client X" },
      { projectId: "p2", group: "Client X" },
    ]);
  });

  it("reports the hosts whose write failed", async () => {
    const writes: Array<{ projectId: string; group: string | null }> = [];
    const outcome = await setProjectGroupOnHosts({
      targets: [
        { serverId: "a", projectId: "p1" },
        { serverId: "b", projectId: "p2" },
      ],
      group: null,
      getClient: (serverId) => client_(writes, serverId === "b"),
    });
    expect(outcome).toEqual({ kind: "failed", serverIds: ["b"] });
    expect(writes).toEqual([{ projectId: "p1", group: null }]);
  });
});

describe("connectedProjectGroupClient", () => {
  const client = { setProjectGroup: async () => ({ group: null }) };

  it("hands back the client only while the host is online", () => {
    expect(connectedProjectGroupClient({ client, connectionStatus: "online" })).toBe(client);
  });

  it("treats a host that kept its client through an offline spell as disconnected", () => {
    expect(connectedProjectGroupClient({ client, connectionStatus: "offline" })).toBeNull();
    expect(connectedProjectGroupClient({ client, connectionStatus: "connecting" })).toBeNull();
    expect(connectedProjectGroupClient({ client, connectionStatus: "error" })).toBeNull();
    expect(connectedProjectGroupClient({ client, connectionStatus: "idle" })).toBeNull();
    expect(connectedProjectGroupClient(null)).toBeNull();
  });

  it("stops every write when one host is offline but still holds a client", async () => {
    const writes: Array<{ projectId: string; group: string | null }> = [];
    const snapshots = {
      a: { client: client_(writes), connectionStatus: "online" as const },
      b: { client: client_(writes), connectionStatus: "offline" as const },
    };
    const outcome = await setProjectGroupOnHosts({
      targets: [
        { serverId: "a", projectId: "p1" },
        { serverId: "b", projectId: "p2" },
      ],
      group: "Client X",
      getClient: (serverId) =>
        connectedProjectGroupClient(snapshots[serverId as keyof typeof snapshots]),
    });
    expect(outcome).toEqual({ kind: "host_disconnected", serverIds: ["b"] });
    expect(writes).toEqual([]);
  });
});

describe("collectProjectGroups", () => {
  it("merges names case-insensitively across hosts, keeps the first casing, and sorts", () => {
    const hostA = new Map([
      ["p1", { projectGroup: "Zeta" }],
      ["p2", { projectGroup: "Client X" }],
      ["p3", { projectGroup: null }],
    ]);
    const hostB = new Map([
      ["p4", { projectGroup: "client x" }],
      ["p5", { projectGroup: "  Alpha " }],
    ]);
    expect(collectProjectGroups([hostA, hostB])).toEqual([
      { key: "alpha", name: "Alpha" },
      { key: "client x", name: "Client X" },
      { key: "zeta", name: "Zeta" },
    ]);
  });
});

describe("normalizeProjectGroupName", () => {
  it("trims and turns empty names into null", () => {
    expect(normalizeProjectGroupName("  Client X ")).toBe("Client X");
    expect(normalizeProjectGroupName("   ")).toBeNull();
    expect(normalizeProjectGroupName(null)).toBeNull();
  });
});
