import { describe, expect, it } from "vitest";
import { normalizeStoredHostProfile } from "./host-connection";

describe("normalizeStoredHostProfile", () => {
  it("loads direct TCP connections stored before TLS and password fields existed", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      label: "Old Host",
      connections: [
        {
          id: "direct:127.0.0.1:6767",
          type: "directTcp",
          endpoint: "127.0.0.1:6767",
        },
      ],
      preferredConnectionId: "direct:127.0.0.1:6767",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(profile).not.toBeNull();
    expect(profile?.connections[0]).toEqual({
      id: "direct:localhost:6767",
      type: "directTcp",
      endpoint: "localhost:6767",
      useTls: false,
    });
    expect(profile?.connections[0]).not.toHaveProperty("password");
  });
});
