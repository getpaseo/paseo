import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolveMobilePanelGestureIntent } from "../../mobile-panels/gesture-intent";
import {
  createActivePromptPublisher,
  shouldAcceptPromptIndexEpoch,
  promptTickMagnification,
  resolveActivePromptSeq,
  resolveOutlineAccessibilityIndex,
  resolveOutlinePreviewTop,
  resolveOutlineScrubIntent,
  resolvePromptSlotAt,
  resolveReadingPosition,
  OUTLINE_MAGNIFY_RADIUS,
  type ChatOutlinePrompt,
  type OutlinePreviewPlacement,
  type ReadingRow,
} from "./model";

describe("chat outline prompt index epoch", () => {
  it("accepts only the authoritative timeline epoch", () => {
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-2")).toBe(true);
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-1")).toBe(false);
  });
});

function prompt(seq: number): ChatOutlinePrompt {
  return { seq, timestamp: new Date(seq).toISOString(), preview: `prompt ${seq}` };
}

describe("resolvePromptSlotAt", () => {
  it("maps a touch to the slot under it, with slots tiling the rail", () => {
    expect(resolvePromptSlotAt({ offsetY: 0, railHeight: 100, slotCount: 4 })).toBe(0);
    expect(resolvePromptSlotAt({ offsetY: 24.9, railHeight: 100, slotCount: 4 })).toBe(0);
    expect(resolvePromptSlotAt({ offsetY: 25, railHeight: 100, slotCount: 4 })).toBe(1);
    expect(resolvePromptSlotAt({ offsetY: 99.9, railHeight: 100, slotCount: 4 })).toBe(3);
  });

  it("keeps the first and last slot while the finger slides past the rail", () => {
    expect(resolvePromptSlotAt({ offsetY: -40, railHeight: 100, slotCount: 4 })).toBe(0);
    expect(resolvePromptSlotAt({ offsetY: 100, railHeight: 100, slotCount: 4 })).toBe(3);
    expect(resolvePromptSlotAt({ offsetY: 400, railHeight: 100, slotCount: 4 })).toBe(3);
  });

  it("has no slot before the rail is measured or when it is empty", () => {
    expect(resolvePromptSlotAt({ offsetY: 10, railHeight: 0, slotCount: 4 })).toBeNull();
    expect(resolvePromptSlotAt({ offsetY: 10, railHeight: 100, slotCount: 0 })).toBeNull();
    expect(resolvePromptSlotAt({ offsetY: Number.NaN, railHeight: 100, slotCount: 4 })).toBeNull();
  });
});

describe("promptTickMagnification", () => {
  it("peaks under the pointer and decays to nothing at the radius", () => {
    expect(promptTickMagnification(0)).toBe(1);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS)).toBe(0);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS + 10)).toBe(0);
  });

  it("falls off monotonically and symmetrically around the pointer", () => {
    const above = [0, 1, 2, 3].map((distance) => promptTickMagnification(distance));
    const below = [0, -1, -2, -3].map((distance) => promptTickMagnification(distance));

    expect(above).toEqual(below);
    expect(above).toEqual([...above].sort((left, right) => right - left));
  });
});

describe("resolveActivePromptSeq", () => {
  const prompts = [prompt(2), prompt(9), prompt(20)];

  it("marks the prompt whose turn the reading position sits in", () => {
    expect(resolveActivePromptSeq(prompts, 9)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 14)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 20)).toBe(20);
    expect(resolveActivePromptSeq(prompts, 99)).toBe(20);
  });

  it("marks nothing above the first prompt or without a reading position", () => {
    expect(resolveActivePromptSeq(prompts, 1)).toBeNull();
    expect(resolveActivePromptSeq(prompts, null)).toBeNull();
    expect(resolveActivePromptSeq([], 42)).toBeNull();
  });
});

describe("createActivePromptPublisher", () => {
  it("notifies subscribers only when the active prompt changes", () => {
    const publisher = createActivePromptPublisher();
    let notifications = 0;
    const unsubscribe = publisher.subscribe(() => {
      notifications += 1;
    });

    publisher.publish(9);
    publisher.publish(9);
    publisher.publish(20);
    unsubscribe();
    publisher.publish(null);

    expect(notifications).toBe(2);
    expect(publisher.getActiveSeq()).toBeNull();
  });
});

function userMessage(id: string, seq: number | null, text = id): StreamItem {
  return {
    kind: "user_message",
    id,
    text,
    timestamp: new Date(Math.max(seq ?? 0, 0)),
    ...(seq === null ? {} : { timelineCursor: { epoch: "epoch-1", seq } }),
  };
}

function assistantRow(id: string, seq: number | null): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: new Date(0),
    ...(seq === null ? {} : { timelineCursor: { epoch: "epoch-1", seq } }),
  };
}

function rowsAboveEachOther(items: StreamItem[]): (id: string) => ReadingRow | undefined {
  const rows = new Map(
    items.map((item, index) => [item.id, { item, aboveItem: items[index - 1] ?? null }]),
  );
  return (id) => rows.get(id);
}

describe("resolveReadingPosition", () => {
  const getRow = rowsAboveEachOther([
    userMessage("prompt", 4),
    assistantRow("answer", 5),
    assistantRow("answer:block:1", null),
    userMessage("optimistic", null),
  ]);

  it("reads the row's own timeline position", () => {
    expect(resolveReadingPosition("answer", getRow)).toEqual({ seq: 5, isPromptRow: false });
    expect(resolveReadingPosition("prompt", getRow)).toEqual({ seq: 4, isPromptRow: true });
  });

  it("places rows without a cursor in the turn of the nearest earlier row", () => {
    expect(resolveReadingPosition("answer:block:1", getRow)).toEqual({
      seq: 5,
      isPromptRow: false,
    });
    expect(resolveReadingPosition("optimistic", getRow)).toEqual({ seq: 5, isPromptRow: true });
  });

  it("reads nothing without a row or any earlier cursor", () => {
    expect(resolveReadingPosition(null, getRow)).toBeNull();
    expect(resolveReadingPosition("missing", getRow)).toBeNull();
    expect(
      resolveReadingPosition("draft", rowsAboveEachOther([userMessage("draft", null)])),
    ).toBeNull();
  });
});

describe("resolveOutlineScrubIntent", () => {
  it("waits through a tap, then scrubs only when vertical travel wins", () => {
    expect([
      resolveOutlineScrubIntent(0, 10),
      resolveOutlineScrubIntent(0, 11),
      resolveOutlineScrubIntent(8, 11),
      resolveOutlineScrubIntent(-4, -30),
      resolveOutlineScrubIntent(12, 40),
    ]).toEqual(["wait", "activate", "activate", "activate", "activate"]);
  });

  it("yields a sideways move before the left drawer would claim it", () => {
    expect([
      resolveOutlineScrubIntent(9, 0),
      resolveOutlineScrubIntent(10, 0),
      resolveOutlineScrubIntent(10, 9),
      resolveOutlineScrubIntent(-16, 4),
      resolveOutlineScrubIntent(40, 12),
      resolveOutlineScrubIntent(Number.NaN, 20),
      resolveOutlineScrubIntent(12, Number.POSITIVE_INFINITY),
    ]).toEqual(["wait", "fail", "fail", "fail", "fail", "fail", "fail"]);
  });

  it("never scrubs a gesture the left drawer would open, or opens one the scrubber takes", () => {
    const conflicts: { dx: number; dy: number; scrub: string; drawer: string }[] = [];
    for (let dx = -30; dx <= 40; dx += 1) {
      for (let dy = -30; dy <= 40; dy += 1) {
        const scrub = resolveOutlineScrubIntent(dx, dy);
        const drawer = resolveMobilePanelGestureIntent({
          deltaX: dx,
          deltaY: dy,
          direction: 1,
          openGesturesBlocked: false,
        });
        if (scrub === "activate" && drawer !== "fail") conflicts.push({ dx, dy, scrub, drawer });
        if (drawer === "activate" && scrub !== "fail") conflicts.push({ dx, dy, scrub, drawer });
      }
    }
    expect(conflicts).toEqual([]);
  });
});

describe("resolveOutlinePreviewTop", () => {
  const placement: OutlinePreviewPlacement = {
    railY: 80,
    columnY: 10,
    columnHeight: 200,
    slotIndex: 3,
    slotCount: 4,
    previewHeight: 64,
    fingerClearance: 24,
  };

  it("sits the bubble above the slot under the finger", () => {
    expect(resolveOutlinePreviewTop(placement)).toBe(177);
  });

  it("keeps the bubble inside the stream when the first slots leave no room above", () => {
    expect(
      resolveOutlinePreviewTop({
        ...placement,
        railY: 0,
        columnY: 0,
        columnHeight: 40,
        slotIndex: 0,
      }),
    ).toBe(0);
  });

  it("has no position before the column is measured", () => {
    expect(resolveOutlinePreviewTop({ ...placement, columnHeight: 0 })).toBeNull();
    expect(resolveOutlinePreviewTop({ ...placement, slotCount: 0 })).toBeNull();
    expect(resolveOutlinePreviewTop({ ...placement, slotIndex: Number.NaN })).toBeNull();
  });
});

describe("resolveOutlineAccessibilityIndex", () => {
  it("steps to the next or previous prompt and does not wrap", () => {
    expect(
      resolveOutlineAccessibilityIndex({ activeIndex: 2, action: "increment", count: 5 }),
    ).toBe(3);
    expect(
      resolveOutlineAccessibilityIndex({ activeIndex: 2, action: "decrement", count: 5 }),
    ).toBe(1);
    expect(
      resolveOutlineAccessibilityIndex({ activeIndex: 0, action: "decrement", count: 5 }),
    ).toBeNull();
    expect(
      resolveOutlineAccessibilityIndex({ activeIndex: 4, action: "increment", count: 5 }),
    ).toBeNull();
  });

  it("enters at the first prompt when nothing is active", () => {
    expect(
      resolveOutlineAccessibilityIndex({ activeIndex: -1, action: "increment", count: 5 }),
    ).toBe(0);
    expect(
      resolveOutlineAccessibilityIndex({ activeIndex: -1, action: "decrement", count: 5 }),
    ).toBeNull();
    expect(
      resolveOutlineAccessibilityIndex({ activeIndex: 0, action: "increment", count: 0 }),
    ).toBeNull();
  });
});
