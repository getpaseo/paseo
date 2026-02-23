import { describe, expect, it } from "vitest";
import { classifySessionTimelineSeq } from "./session-timeline-seq-gate";
import {
  deriveBootstrapTailTimelinePolicy,
  shouldResolveTimelineInit,
} from "./session-timeline-bootstrap-policy";

describe("deriveBootstrapTailTimelinePolicy", () => {
  it("always replaces on explicit reset without catch-up cursor", () => {
    const policy = deriveBootstrapTailTimelinePolicy({
      direction: "after",
      reset: true,
      epoch: "epoch-1",
      endCursor: { seq: 200 },
      isInitializing: false,
      hasActiveInitDeferred: false,
    });

    expect(policy.replace).toBe(true);
    expect(policy.catchUpCursor).toBeNull();
  });

  it("forces baseline replace and canonical catch-up for init tail race", () => {
    const advancedCursor = { epoch: "epoch-1", endSeq: 205 };
    const tailSeqStart = 101;
    const tailSeqEnd = 200;

    let acceptedWithoutBootstrap = 0;
    for (let seq = tailSeqStart; seq <= tailSeqEnd; seq += 1) {
      const decision = classifySessionTimelineSeq({
        cursor: advancedCursor,
        epoch: "epoch-1",
        seq,
      });
      if (decision === "accept" || decision === "init") {
        acceptedWithoutBootstrap += 1;
      }
    }
    expect(acceptedWithoutBootstrap).toBe(0);

    const policy = deriveBootstrapTailTimelinePolicy({
      direction: "tail",
      reset: false,
      epoch: "epoch-1",
      endCursor: { seq: 200 },
      isInitializing: true,
      hasActiveInitDeferred: true,
    });

    expect(policy.replace).toBe(true);
    expect(policy.catchUpCursor).toEqual({
      epoch: "epoch-1",
      endSeq: 200,
    });
  });

  it("does not replace non-bootstrap, non-reset responses", () => {
    const policy = deriveBootstrapTailTimelinePolicy({
      direction: "tail",
      reset: false,
      epoch: "epoch-1",
      endCursor: { seq: 200 },
      isInitializing: false,
      hasActiveInitDeferred: false,
    });

    expect(policy.replace).toBe(false);
    expect(policy.catchUpCursor).toBeNull();
  });
});

describe("shouldResolveTimelineInit", () => {
  it("resolves tail init when the tail response arrives", () => {
    expect(
      shouldResolveTimelineInit({
        hasActiveInitDeferred: true,
        isInitializing: true,
        initRequestDirection: "tail",
        responseDirection: "tail",
        reset: false,
      })
    ).toBe(true);
  });

  it("does not resolve tail init when an after response arrives first", () => {
    expect(
      shouldResolveTimelineInit({
        hasActiveInitDeferred: true,
        isInitializing: true,
        initRequestDirection: "tail",
        responseDirection: "after",
        reset: false,
      })
    ).toBe(false);
  });

  it("resolves after init when an after response arrives", () => {
    expect(
      shouldResolveTimelineInit({
        hasActiveInitDeferred: true,
        isInitializing: true,
        initRequestDirection: "after",
        responseDirection: "after",
        reset: false,
      })
    ).toBe(true);
  });
});
