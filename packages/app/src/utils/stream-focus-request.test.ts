import { describe, expect, it } from "vitest";

import { resolveStreamFocusTarget } from "./stream-focus-request";

describe("resolveStreamFocusTarget", () => {
  it("targets live-head items before authoritative history settles", () => {
    expect(
      resolveStreamFocusTarget({
        itemId: "msg-2",
        historyItemIds: ["msg-1"],
        liveHeadItemIds: ["msg-2", "msg-3"],
      }),
    ).toEqual({
      kind: "live-head",
    });
  });

  it("targets a concrete history index once the requested item is in history", () => {
    expect(
      resolveStreamFocusTarget({
        itemId: "msg-2",
        historyItemIds: ["msg-1", "msg-2", "msg-3"],
        liveHeadItemIds: [],
      }),
    ).toEqual({
      kind: "history",
      index: 1,
    });
  });

  it("returns missing when the requested item has not rendered yet", () => {
    expect(
      resolveStreamFocusTarget({
        itemId: "msg-9",
        historyItemIds: ["msg-1", "msg-2", "msg-3"],
        liveHeadItemIds: [],
      }),
    ).toEqual({
      kind: "missing",
    });
  });
});
