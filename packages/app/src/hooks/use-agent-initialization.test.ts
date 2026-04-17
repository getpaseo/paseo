import { describe, expect, it } from "vitest";
import { __private__ } from "./use-agent-initialization";

describe("useAgentInitialization timeline request policy", () => {
  it("uses canonical tail bootstrap when history has not synced yet", () => {
    expect(
      __private__.deriveInitialTimelineRequest({
        cursor: {
          epoch: "epoch-1",
          seq: 42,
        },
        hasAuthoritativeHistory: false,
        initialTimelineLimit: 200,
      }),
    ).toEqual({
      direction: "tail",
      limit: 200,
      projection: "canonical",
    });
  });

  it("uses canonical tail bootstrap when cursor is missing", () => {
    expect(
      __private__.deriveInitialTimelineRequest({
        cursor: null,
        hasAuthoritativeHistory: true,
        initialTimelineLimit: 200,
      }),
    ).toEqual({
      direction: "tail",
      limit: 200,
      projection: "canonical",
    });
  });

  it("uses canonical catch-up after the current cursor once history is synced", () => {
    expect(
      __private__.deriveInitialTimelineRequest({
        cursor: {
          epoch: "epoch-1",
          seq: 42,
        },
        hasAuthoritativeHistory: true,
        initialTimelineLimit: 200,
      }),
    ).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: 0,
      projection: "canonical",
    });
  });

  it("supports unbounded tail bootstrap policy", () => {
    expect(
      __private__.deriveInitialTimelineRequest({
        cursor: null,
        hasAuthoritativeHistory: false,
        initialTimelineLimit: 0,
      }),
    ).toEqual({
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
  });

  it("uses the configured native message limit on mobile platforms", () => {
    expect(
      __private__.resolveInitialTimelineLimit({
        platform: "ios",
        nativeInitialTimelineLimit: 500,
      }),
    ).toBe(500);
  });

  it("defaults mobile platforms to the bounded native bootstrap window", () => {
    expect(
      __private__.resolveInitialTimelineLimit({
        platform: "android",
      }),
    ).toBe(100);
  });

  it("keeps web bootstraps unbounded regardless of the native setting", () => {
    expect(
      __private__.resolveInitialTimelineLimit({
        platform: "web",
        nativeInitialTimelineLimit: 500,
      }),
    ).toBe(0);
  });

  it("does not expose an RPC-success init fallback", () => {
    expect("shouldResolveInitFromRpcSuccess" in __private__).toBe(false);
  });
});
