import { beforeEach, describe, expect, it } from "vitest";

import {
  createLiveVoiceHoldMuteController,
  type LiveVoiceHoldMuteTarget,
} from "./live-voice-hold-mute";

function createTarget(initial: { active?: boolean; muted?: boolean } = {}) {
  const state = {
    active: initial.active ?? true,
    muted: initial.muted ?? false,
    calls: [] as boolean[],
  };
  const target: LiveVoiceHoldMuteTarget = {
    isActive: () => state.active,
    isMuted: () => state.muted,
    setMuted: (muted) => {
      state.calls.push(muted);
      state.muted = muted;
    },
  };
  return { state, target };
}

describe("live voice hold-to-invert mute", () => {
  let target: ReturnType<typeof createTarget>;

  beforeEach(() => {
    target = createTarget();
  });

  it("unmutes for the duration of the hold when the call started muted", () => {
    const { state, target: deps } = createTarget({ muted: true });
    const controller = createLiveVoiceHoldMuteController(deps);

    expect(controller.press()).toBe(true);
    expect(state.muted).toBe(false);
    expect(controller.isHeld()).toBe(true);

    expect(controller.release()).toBe(true);
    expect(state.muted).toBe(true);
    expect(state.calls).toEqual([false, true]);
    expect(controller.isHeld()).toBe(false);
  });

  it("mutes for the duration of the hold when the call started unmuted", () => {
    const { state, target: deps } = createTarget({ muted: false });
    const controller = createLiveVoiceHoldMuteController(deps);

    controller.press();
    expect(state.muted).toBe(true);

    controller.release();
    expect(state.muted).toBe(false);
    expect(state.calls).toEqual([true, false]);
  });

  it("ignores repeat presses while the chord is held", () => {
    const { state, target: deps } = createTarget({ muted: true });
    const controller = createLiveVoiceHoldMuteController(deps);

    controller.press();
    expect(controller.press()).toBe(true);
    expect(controller.press()).toBe(true);
    expect(state.calls).toEqual([false]);

    controller.release();
    expect(state.calls).toEqual([false, true]);
  });

  it("restores the state captured at press even if mute changed mid-hold", () => {
    const { state, target: deps } = createTarget({ muted: true });
    const controller = createLiveVoiceHoldMuteController(deps);

    controller.press();
    // Something else toggled mute while the chord was down.
    state.muted = true;

    controller.release();
    expect(state.muted).toBe(true);
  });

  it("stays inert while no call is active", () => {
    const { state, target: deps } = createTarget({ active: false });
    const controller = createLiveVoiceHoldMuteController(deps);

    expect(controller.press()).toBe(false);
    expect(controller.isHeld()).toBe(false);
    expect(controller.release()).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("does not restore into a call that ended mid-hold", () => {
    const { state, target: deps } = createTarget({ muted: true });
    const controller = createLiveVoiceHoldMuteController(deps);

    controller.press();
    state.active = false;

    expect(controller.release()).toBe(true);
    expect(state.calls).toEqual([false]);
    expect(controller.isHeld()).toBe(false);
  });

  it("drops the captured state when the hold is cancelled", () => {
    const { state, target: deps } = createTarget({ muted: true });
    const controller = createLiveVoiceHoldMuteController(deps);

    controller.press();
    controller.cancel();

    expect(controller.isHeld()).toBe(false);
    expect(controller.release()).toBe(false);
    expect(state.calls).toEqual([false]);
  });

  it("re-arms after a release", () => {
    const controller = createLiveVoiceHoldMuteController(target.target);

    controller.press();
    controller.release();
    controller.press();

    expect(target.state.muted).toBe(true);
    expect(target.state.calls).toEqual([true, false, true]);
  });
});
