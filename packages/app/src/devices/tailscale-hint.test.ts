import { describe, expect, it } from "vitest";
import type { TailscaleStatus } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { describeTailscale } from "./tailscale-hint";

// Statuses as the host reports them; see `createDaemonListeners` in the server's listeners.ts.
const off: TailscaleStatus = { ip: "100.101.102.103", address: null, state: "off" };

describe("the Tailscale row's hint", () => {
  it("says why Tailscale stays off when the host listens on a socket", () => {
    const socketHint = "Off, because this host listens on a local socket";
    expect(describeTailscale({ ...off, lockedBy: "main", mainIsSocket: true }, i18n.t)).toBe(
      socketHint,
    );
    expect(describeTailscale({ ...off, lockedBy: "launch", mainIsSocket: true }, i18n.t)).toBe(
      socketHint,
    );
  });

  it("keeps the hint of every other state", () => {
    const hint = (status: TailscaleStatus) => describeTailscale(status, i18n.t);
    expect(hint(off)).toBe("Direct over your tailnet, enter an address");
    expect(hint({ ip: null, address: null, state: "unavailable", lockedBy: "launch" })).toBe(
      "Tailscale is not running on this host",
    );
    expect(hint({ ...off, state: "waiting", address: "100.101.102.103:6767" })).toBe(
      "Waiting for Tailscale to start on this host",
    );
    expect(hint({ ...off, state: "on", address: "100.101.102.103:6767", lockedBy: "main" })).toBe(
      "Always on, because this host already accepts Tailscale connections",
    );
    expect(hint({ ...off, lockedBy: "launch" })).toBe(
      "Controlled by the command that starts this host",
    );
  });
});
