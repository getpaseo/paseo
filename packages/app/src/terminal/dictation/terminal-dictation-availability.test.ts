import { describe, expect, it } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import { resolveTerminalDictationAvailability } from "./terminal-dictation-availability";

function serverInfo(capabilities?: DaemonServerInfo["capabilities"]): DaemonServerInfo {
  return {
    serverId: "server-a",
    hostname: null,
    version: "0.13.2",
    ...(capabilities ? { capabilities } : {}),
  };
}

function voice(dictation: { enabled: boolean; reason: string }): DaemonServerInfo["capabilities"] {
  return { voice: { dictation, voice: { enabled: false, reason: "" } } };
}

describe("resolveTerminalDictationAvailability", () => {
  it("is disconnected while the host is not connected, whatever it reports", () => {
    expect(
      resolveTerminalDictationAvailability({
        serverInfo: serverInfo(voice({ enabled: true, reason: "" })),
        isConnected: false,
      }),
    ).toEqual({ kind: "disconnected" });
  });

  it("asks to update a host that reports no capabilities", () => {
    expect(
      resolveTerminalDictationAvailability({ serverInfo: serverInfo(), isConnected: true }),
    ).toEqual({ kind: "unavailable", reason: "update-host" });
    expect(resolveTerminalDictationAvailability({ serverInfo: null, isConnected: true })).toEqual({
      kind: "unavailable",
      reason: "update-host",
    });
  });

  it("asks to update a host whose capabilities have no voice field", () => {
    expect(
      resolveTerminalDictationAvailability({ serverInfo: serverInfo({}), isConnected: true }),
    ).toEqual({ kind: "unavailable", reason: "update-host" });
  });

  it("carries the host's trimmed reason when dictation is disabled", () => {
    expect(
      resolveTerminalDictationAvailability({
        serverInfo: serverInfo(voice({ enabled: false, reason: "  No speech model installed " })),
        isConnected: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "disabled", message: "No speech model installed" });
  });

  it.each(["", "   "])("leaves the message empty for a disabled reason of %j", (reason) => {
    expect(
      resolveTerminalDictationAvailability({
        serverInfo: serverInfo(voice({ enabled: false, reason })),
        isConnected: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "disabled", message: null });
  });

  it("is ready when the host enables dictation", () => {
    expect(
      resolveTerminalDictationAvailability({
        serverInfo: serverInfo(voice({ enabled: true, reason: "" })),
        isConnected: true,
      }),
    ).toEqual({ kind: "ready" });
  });
});
