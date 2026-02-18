import { describe, expect, it } from "vitest";
import type { ServerCapabilities } from "@server/shared/messages";
import type { DaemonServerInfo } from "@/stores/session-store";
import {
  getServerCapabilities,
  getVoiceReadinessState,
  resolveVoiceUnavailableMessage,
} from "./server-info-capabilities";

function buildServerInfo(capabilities?: ServerCapabilities): DaemonServerInfo {
  return {
    serverId: "srv-1",
    hostname: "test-host",
    version: "0.1.0",
    ...(capabilities ? { capabilities } : {}),
  };
}

describe("server-info-capabilities", () => {
  it("returns null capabilities when server_info does not include capability metadata", () => {
    const serverInfo = buildServerInfo();
    expect(getServerCapabilities({ serverInfo })).toBeNull();
  });

  it("returns the matching voice capability state by mode", () => {
    const capabilities: ServerCapabilities = {
      voice: {
        dictation: {
          enabled: true,
          reason: "Dictation is warming up.",
        },
        voice: {
          enabled: false,
          reason: "Voice is disabled in daemon config.",
        },
      },
    };
    const serverInfo = buildServerInfo(capabilities);

    expect(
      getVoiceReadinessState({
        serverInfo,
        mode: "dictation",
      })
    ).toEqual(capabilities.voice?.dictation);
    expect(
      getVoiceReadinessState({
        serverInfo,
        mode: "voice",
      })
    ).toEqual(capabilities.voice?.voice);
  });

  it("returns null when capability is enabled and has no reason", () => {
    const serverInfo = buildServerInfo({
      voice: {
        dictation: {
          enabled: true,
          reason: "",
        },
        voice: {
          enabled: true,
          reason: "",
        },
      },
    });

    expect(
      resolveVoiceUnavailableMessage({
        serverInfo,
        mode: "dictation",
      })
    ).toBeNull();
  });

  it("returns capability reason when present", () => {
    const serverInfo = buildServerInfo({
      voice: {
        dictation: {
          enabled: true,
          reason: "Dictation models are still downloading.",
        },
        voice: {
          enabled: true,
          reason: "",
        },
      },
    });

    expect(
      resolveVoiceUnavailableMessage({
        serverInfo,
        mode: "dictation",
      })
    ).toBe("Dictation models are still downloading.");
  });

  it("returns null when capability reason is blank", () => {
    const serverInfo = buildServerInfo({
      voice: {
        dictation: {
          enabled: false,
          reason: "   ",
        },
        voice: {
          enabled: true,
          reason: "",
        },
      },
    });

    expect(
      resolveVoiceUnavailableMessage({
        serverInfo,
        mode: "dictation",
      })
    ).toBeNull();
  });
});
