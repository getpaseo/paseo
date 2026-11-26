import { describe, expect, it } from "vitest";
import { NetworkTunnelTicketStore } from "./ticket-store.js";

describe("NetworkTunnelTicketStore", () => {
  it("issues single-use tickets with 30s TTL carrying principalId and permissions", () => {
    let now = 1_000_000;
    const store = new NetworkTunnelTicketStore({ clock: () => now });

    const issued = store.issue({
      principalId: "principal-1",
      permissions: ["workspace.read", "workspace.write"],
    });
    expect(issued.ticket.length).toBeGreaterThanOrEqual(32);
    expect(issued.expiresAtMs).toBe(now + 30_000);

    now += 15_000;
    const redeemed = store.redeem(issued.ticket);
    expect(redeemed).toEqual({
      principalId: "principal-1",
      permissions: ["workspace.read", "workspace.write"],
    });

    // Replay must fail closed
    expect(store.redeem(issued.ticket)).toBeNull();
  });

  it("rejects expired tickets and purges them", () => {
    let now = 2_000_000;
    const store = new NetworkTunnelTicketStore({ clock: () => now, ttlMs: 30_000 });

    const issued = store.issue({
      principalId: "principal-1",
      permissions: ["workspace.write"],
    });

    now += 30_000;
    expect(store.redeem(issued.ticket)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("bounds stored ticket count by evicting expired then oldest tickets", () => {
    let now = 3_000_000;
    let seq = 0;
    const store = new NetworkTunnelTicketStore({
      clock: () => now,
      ttlMs: 30_000,
      maxTickets: 2,
      generateToken: () => `ticket-${++seq}`,
    });

    const first = store.issue({ principalId: "p1", permissions: ["workspace.write"] });
    now += 1_000;
    const second = store.issue({ principalId: "p2", permissions: ["workspace.write"] });
    now += 1_000;
    const third = store.issue({ principalId: "p3", permissions: ["workspace.write"] });

    expect(store.size).toBe(2);
    expect(store.redeem(first.ticket)).toBeNull();
    expect(store.redeem(second.ticket)?.principalId).toBe("p2");
    expect(store.redeem(third.ticket)?.principalId).toBe("p3");
  });

  it("revokes all outstanding tickets for a principal", () => {
    const store = new NetworkTunnelTicketStore();
    const t1 = store.issue({ principalId: "p1", permissions: ["workspace.write"] });
    const t2 = store.issue({ principalId: "p1", permissions: ["workspace.write"] });
    const other = store.issue({ principalId: "p2", permissions: ["workspace.write"] });

    store.revokePrincipal("p1");

    expect(store.redeem(t1.ticket)).toBeNull();
    expect(store.redeem(t2.ticket)).toBeNull();
    expect(store.redeem(other.ticket)?.principalId).toBe("p2");
  });
});
