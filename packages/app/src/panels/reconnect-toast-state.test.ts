import { describe, expect, it } from "vitest";
import { reconcileReconnectToastState, type ReconnectToastState } from "./reconnect-toast-state";

describe("reconnect toast presentation state", () => {
  it("resets after the host recovers without a mounted agent panel", () => {
    const presented: ReconnectToastState = {
      connectionStatusStartedAt: 100,
      presented: true,
    };

    expect(reconcileReconnectToastState(presented, 100)).toBe(presented);
    expect(reconcileReconnectToastState(presented, 200)).toEqual({
      connectionStatusStartedAt: 200,
      presented: false,
    });
  });
});
