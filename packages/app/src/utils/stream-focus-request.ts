export type StreamFocusTarget =
  | { kind: "history"; index: number }
  | { kind: "live-head" }
  | { kind: "missing" };

export type StreamFocusRequest = {
  itemId: string;
  requestKey: string;
};

export function resolveStreamFocusTarget(input: {
  itemId: string;
  historyItemIds: readonly string[];
  liveHeadItemIds: readonly string[];
}): StreamFocusTarget {
  if (input.liveHeadItemIds.includes(input.itemId)) {
    return { kind: "live-head" };
  }

  const historyIndex = input.historyItemIds.indexOf(input.itemId);
  if (historyIndex >= 0) {
    return { kind: "history", index: historyIndex };
  }

  return { kind: "missing" };
}
