import { describe, expect, it } from "vitest";
import {
  resolveLiveVoiceAvailability,
  type LiveVoiceHostAvailability,
} from "@/live-voice/live-voice-availability-policy";

function host(overrides: Partial<LiveVoiceHostAvailability> = {}): LiveVoiceHostAvailability {
  return {
    serverId: "host-a",
    label: "Host A",
    connectionStatus: "online",
    version: "0.2.5",
    supportsLiveVoice: true,
    ...overrides,
  };
}

describe("resolveLiveVoiceAvailability", () => {
  it("reports an unsupported client platform before considering hosts", () => {
    const availability = resolveLiveVoiceAvailability({
      isPlatformSupported: false,
      hosts: [host()],
    });

    expect(availability).toEqual({
      kind: "unavailable",
      reason: "platform_unsupported",
      hosts: [host()],
    });
  });

  it("reports when no hosts are configured", () => {
    const availability = resolveLiveVoiceAvailability({
      isPlatformSupported: true,
      hosts: [],
    });

    expect(availability).toEqual({ kind: "unavailable", reason: "no_hosts", hosts: [] });
  });

  it("offers only online hosts that advertise live voice", () => {
    const capable = host();
    const oldDaemon = host({
      serverId: "host-b",
      label: "Host B",
      version: "0.2.4",
      supportsLiveVoice: false,
    });
    const offline = host({
      serverId: "host-c",
      label: "Host C",
      connectionStatus: "offline",
    });

    const availability = resolveLiveVoiceAvailability({
      isPlatformSupported: true,
      hosts: [oldDaemon, capable, offline],
    });

    expect(availability).toEqual({ kind: "available", hosts: [capable] });
  });

  it("identifies connected daemons that need an upgrade", () => {
    const oldDaemon = host({ version: "0.2.4", supportsLiveVoice: false });
    const availability = resolveLiveVoiceAvailability({
      isPlatformSupported: true,
      hosts: [oldDaemon],
    });

    expect(availability).toEqual({
      kind: "unavailable",
      reason: "host_upgrade_required",
      hosts: [oldDaemon],
    });
  });

  it("keeps the launcher in a connecting state while server info is pending", () => {
    const handshaking = host({ version: null, supportsLiveVoice: null });
    const availability = resolveLiveVoiceAvailability({
      isPlatformSupported: true,
      hosts: [handshaking],
    });

    expect(availability).toEqual({
      kind: "unavailable",
      reason: "hosts_connecting",
      hosts: [handshaking],
    });
  });

  it("reports that configured hosts are offline", () => {
    const offline = host({ connectionStatus: "offline", supportsLiveVoice: null });
    const availability = resolveLiveVoiceAvailability({
      isPlatformSupported: true,
      hosts: [offline],
    });

    expect(availability).toEqual({
      kind: "unavailable",
      reason: "hosts_offline",
      hosts: [offline],
    });
  });
});
