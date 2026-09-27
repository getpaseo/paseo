import { describe, expect, it } from "vitest";
import { statusFromDaemonProbe } from "./daemon-status.js";

describe("daemon status probe", () => {
  const running = {
    localDaemon: "running",
    pid: 1234,
    listen: "127.0.0.1:6767",
  };
  const expected = {
    serverId: "",
    status: "running",
    listen: "127.0.0.1:6767",
    hostname: null,
    pid: 1234,
    home: "/test-home",
    version: null,
    desktopManaged: false,
    ownedByDesktop: false,
    startedAt: null,
    error: null,
  };

  it.each(["auth_required", "auth_failed"])(
    "preserves %s without reporting a running daemon as stopped",
    (connectedDaemon) => {
      expect(
        statusFromDaemonProbe(
          { ...running, connectedDaemon, note: "Password required" },
          "/test-home",
          null,
        ),
      ).toEqual({ ...expected, error: "Password required" });
    },
  );

  it("reports an authentication error when the probe has no note", () => {
    expect(
      statusFromDaemonProbe({ ...running, connectedDaemon: "auth_failed" }, "/test-home", null),
    ).toEqual({ ...expected, error: "Daemon authentication failed." });
  });

  it("keeps a successful probe available for identity resolution", () => {
    expect(
      statusFromDaemonProbe(
        { ...running, connectedDaemon: "connected", serverId: "srv_local" },
        "/test-home",
        null,
      ),
    ).toEqual({ ...expected, serverId: "srv_local" });
  });
});
