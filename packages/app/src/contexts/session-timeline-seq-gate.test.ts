import { describe, expect, it } from "vitest";
import { classifySessionTimelineSeq } from "./session-timeline-seq-gate";

describe("classifySessionTimelineSeq", () => {
  it("accepts contiguous forward seq", () => {
    expect(
      classifySessionTimelineSeq({
        cursor: { epoch: "epoch-1", endSeq: 4 },
        epoch: "epoch-1",
        seq: 5,
      })
    ).toBe("accept");
  });

  it("drops stale seq older than the current end", () => {
    expect(
      classifySessionTimelineSeq({
        cursor: { epoch: "epoch-1", endSeq: 8 },
        epoch: "epoch-1",
        seq: 7,
      })
    ).toBe("drop_stale");
  });

  it("drops duplicate replay seq equal to the current end", () => {
    expect(
      classifySessionTimelineSeq({
        cursor: { epoch: "epoch-1", endSeq: 8 },
        epoch: "epoch-1",
        seq: 8,
      })
    ).toBe("drop_stale");
  });

  it("drops epoch mismatch", () => {
    expect(
      classifySessionTimelineSeq({
        cursor: { epoch: "epoch-1", endSeq: 4 },
        epoch: "epoch-2",
        seq: 5,
      })
    ).toBe("drop_epoch");
  });

  it("initializes when cursor is null", () => {
    expect(
      classifySessionTimelineSeq({
        cursor: null,
        epoch: "epoch-1",
        seq: 1,
      })
    ).toBe("init");
  });

  it("classifies forward gaps", () => {
    expect(
      classifySessionTimelineSeq({
        cursor: { epoch: "epoch-1", endSeq: 4 },
        epoch: "epoch-1",
        seq: 9,
      })
    ).toBe("gap");
  });
});
