import { describe, expect, it } from "vitest";
import { createAgentAttentionController } from "./agent-attention";

describe("agent attention acknowledgement", () => {
  function setup() {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const controller = createAgentAttentionController({
      clear: async () => {
        calls.push("clear");
      },
      onError: (failure) => errors.push(failure),
    });
    const state = {
      focused: true,
      ready: true,
      requiresAttention: false,
      attentionReason: "finished" as const,
      focusRequest: null as object | null,
    };
    return { controller, state, calls, errors };
  }

  it("acknowledges entry, but keeps attention arriving while focused until another focus action", async () => {
    const { controller, state, calls } = setup();
    controller.update(state);
    state.requiresAttention = true;
    controller.update(state);
    expect(calls).toEqual([]);
    controller.update({ ...state, focusRequest: {} });
    expect(calls).toEqual(["clear"]);
    await Promise.resolve();
    controller.update({ ...state, focusRequest: {} });
    expect(calls).toEqual(["clear", "clear"]);
  });

  it("clears on entry and never clears on leaving", async () => {
    const { controller, state, calls } = setup();
    controller.update({ ...state, requiresAttention: true });
    expect(calls).toEqual(["clear"]);
    await Promise.resolve();
    controller.update({ ...state, focused: false, requiresAttention: true });
    expect(calls).toEqual(["clear"]);
    controller.update({ ...state, requiresAttention: true });
    expect(calls).toEqual(["clear", "clear"]);
  });

  it("waits for connection and agent data before consuming entry", () => {
    const { controller, state, calls } = setup();
    controller.update({ ...state, ready: false });
    controller.update({ ...state, requiresAttention: true });
    expect(calls).toEqual(["clear"]);
  });

  it("does not treat reconnecting as another focus action", () => {
    const { controller, state, calls } = setup();
    controller.update(state);
    controller.update({ ...state, requiresAttention: true });
    controller.update({ ...state, requiresAttention: true, ready: false });
    controller.update({ ...state, requiresAttention: true });
    expect(calls).toEqual([]);
    controller.focus();
    expect(calls).toEqual(["clear"]);
  });

  it("holds a repeat focus while cached data is waiting for synchronization", () => {
    const { controller, state, calls } = setup();
    controller.update(state);
    controller.update({ ...state, ready: false });
    controller.focus();
    controller.update({ ...state, ready: false, requiresAttention: true });
    expect(calls).toEqual([]);
    controller.update({ ...state, requiresAttention: true });
    expect(calls).toEqual(["clear"]);
  });

  it("drops a pending focus when the user leaves before fresh data arrives", () => {
    const { controller, state, calls } = setup();
    controller.update({ ...state, ready: false });
    controller.update({ ...state, focused: false, requiresAttention: true });
    expect(calls).toEqual([]);
  });

  it("keeps permission attention and deduplicates an in-flight acknowledgement", () => {
    const { controller, state, calls } = setup();
    controller.update({ ...state, requiresAttention: true, attentionReason: "permission" });
    controller.focus();
    expect(calls).toEqual([]);
    controller.update({ ...state, requiresAttention: true });
    controller.focus();
    controller.focus();
    expect(calls).toEqual(["clear"]);
  });

  it("reports failure and allows the next interaction to retry", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const error = new Error("Disconnected");
    const controller = createAgentAttentionController({
      clear: async () => {
        if (++calls === 1) throw error;
      },
      onError: (failure) => errors.push(failure),
    });
    controller.update({
      focused: true,
      ready: true,
      requiresAttention: true,
      attentionReason: "finished",
      focusRequest: null,
    });
    await Promise.resolve();
    expect(errors).toEqual([error]);
    controller.focus();
    expect(calls).toBe(2);
  });
});
