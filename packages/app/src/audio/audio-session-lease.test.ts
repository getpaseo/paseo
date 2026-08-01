import { describe, expect, it, vi } from "vitest";
import { createAudioSessionLease } from "./audio-session-lease";

describe("audio session lease", () => {
  it("grants the lease to the first caller and refuses every other owner", () => {
    const lease = createAudioSessionLease();

    const dictation = lease.acquire("dictation");
    expect(dictation).not.toBeNull();
    expect(lease.current()).toBe("dictation");

    expect(lease.acquire("liveVoice")).toBeNull();
    expect(lease.acquire("voiceMode")).toBeNull();
    // Still held by the original owner — a refusal never disturbs the incumbent.
    expect(lease.current()).toBe("dictation");
  });

  it("refuses reentrant acquisition by the same owner", () => {
    const lease = createAudioSessionLease();
    const first = lease.acquire("voiceMode");
    expect(first).not.toBeNull();
    expect(lease.acquire("voiceMode")).toBeNull();
    expect(lease.isHeldBy(first)).toBe(true);
  });

  it("releases only for the token that currently holds it", () => {
    const lease = createAudioSessionLease();
    const stale = lease.acquire("dictation");
    lease.release(stale);
    expect(lease.current()).toBeNull();

    const current = lease.acquire("liveVoice");
    expect(current).not.toBeNull();

    // A late cleanup from the previous owner must not steal the live lease.
    lease.release(stale);
    expect(lease.current()).toBe("liveVoice");
    expect(lease.isHeldBy(current)).toBe(true);

    lease.release(current);
    expect(lease.current()).toBeNull();
    expect(lease.isHeldBy(current)).toBe(false);
  });

  it("ignores release of a null token", () => {
    const lease = createAudioSessionLease();
    const token = lease.acquire("liveVoice");
    lease.release(null);
    lease.release(undefined);
    expect(lease.isHeldBy(token)).toBe(true);
  });

  it("notifies subscribers on acquire and release, and stops after unsubscribe", () => {
    const lease = createAudioSessionLease();
    const listener = vi.fn();
    const unsubscribe = lease.subscribe(listener);

    const token = lease.acquire("dictation");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(lease.getSnapshot()).toBe("dictation");

    // A refused acquisition changes nothing, so it must not notify.
    lease.acquire("liveVoice");
    expect(listener).toHaveBeenCalledTimes(1);

    lease.release(token);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(lease.getSnapshot()).toBeNull();

    unsubscribe();
    lease.acquire("voiceMode");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("survives a throwing subscriber", () => {
    const lease = createAudioSessionLease();
    lease.subscribe(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    lease.subscribe(healthy);

    const token = lease.acquire("liveVoice");
    expect(token).not.toBeNull();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(lease.current()).toBe("liveVoice");
  });
});
