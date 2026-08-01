import { afterEach, describe, expect, it } from "vitest";
import type { LiveVoiceSnapshot } from "./live-voice-runtime";
import {
  isAuthorizedLiveVoiceRoute,
  registerLiveVoiceRouteAuthority,
} from "./live-voice-route-authority";

const ACTIVE_SNAPSHOT: LiveVoiceSnapshot = {
  phase: "active",
  serverId: "source-host",
  liveSessionId: "live-call",
  sessionMode: "background",
  isMuted: false,
  isAudioBlocked: false,
  transcripts: [],
  error: null,
  closedCause: null,
};

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("Live Voice route authority", () => {
  it("authorizes only the exact active source call", () => {
    unregister = registerLiveVoiceRouteAuthority({
      getSnapshot: () => ACTIVE_SNAPSHOT,
    });

    expect(isAuthorizedLiveVoiceRoute("source-host", "live-call")).toBe(true);
    expect(isAuthorizedLiveVoiceRoute("other-host", "live-call")).toBe(false);
    expect(isAuthorizedLiveVoiceRoute("source-host", "stale-call")).toBe(false);
  });

  it("rejects routes after the call leaves an active phase", () => {
    let snapshot = ACTIVE_SNAPSHOT;
    unregister = registerLiveVoiceRouteAuthority({
      getSnapshot: () => snapshot,
    });

    snapshot = { ...snapshot, phase: "idle" };

    expect(isAuthorizedLiveVoiceRoute("source-host", "live-call")).toBe(false);
  });

  it("does not let stale cleanup clear a newer authority", () => {
    const unregisterFirst = registerLiveVoiceRouteAuthority({
      getSnapshot: () => ACTIVE_SNAPSHOT,
    });
    unregister = registerLiveVoiceRouteAuthority({
      getSnapshot: () => ({ ...ACTIVE_SNAPSHOT, liveSessionId: "new-call" }),
    });

    unregisterFirst();

    expect(isAuthorizedLiveVoiceRoute("source-host", "new-call")).toBe(true);
  });
});
