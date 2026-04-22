import { describe, expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { resolveActiveHost } from "./active-host";

function host(serverId: string): HostProfile {
  return {
    serverId,
    label: serverId,
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: "",
    updatedAt: "",
  };
}

describe("resolveActiveHost", () => {
  it("uses the route host when it exists", () => {
    expect(
      resolveActiveHost({
        hosts: [host("srv-1"), host("srv-2")],
        pathname: "/h/srv-2/workspace/ws-main",
      })?.serverId,
    ).toBe("srv-2");
  });

  it("falls back to the first host when the route host is missing", () => {
    expect(
      resolveActiveHost({
        hosts: [host("srv-1"), host("srv-2")],
        pathname: "/h/missing/workspace/ws-main",
      })?.serverId,
    ).toBe("srv-1");
  });

  it("returns null when no hosts exist", () => {
    expect(resolveActiveHost({ hosts: [], pathname: "/settings" })).toBeNull();
  });
});
