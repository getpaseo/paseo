import { describe, expect, it } from "vitest";
import { hasDaemonReconnectedAfter } from "./daemon-reconnect";

describe("daemon update reconnect detection", () => {
  it("accepts a reconnect performed by the existing daemon client", () => {
    const start = {
      clientGeneration: 4,
      lastOnlineAt: "2026-07-16T10:00:00.000Z",
    };

    const reconnected = hasDaemonReconnectedAfter(
      {
        connectionStatus: "online",
        clientGeneration: 4,
        lastOnlineAt: "2026-07-16T10:00:05.000Z",
      },
      start,
    );

    expect(reconnected).toBe(true);
  });

  it("does not accept the original connection before the daemon restarts", () => {
    const start = {
      clientGeneration: 4,
      lastOnlineAt: "2026-07-16T10:00:00.000Z",
    };

    const reconnected = hasDaemonReconnectedAfter(
      {
        connectionStatus: "online",
        ...start,
      },
      start,
    );

    expect(reconnected).toBe(false);
  });
});
