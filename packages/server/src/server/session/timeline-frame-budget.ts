import { MAX_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/websocket-message-limit";

// Routed replies add their own envelope around the session frame.
const TIMELINE_FRAME_BUDGET_BYTES = MAX_WEBSOCKET_MESSAGE_BYTES - 64 * 1024;

interface TimelineRequest {
  wholeTurns?: boolean;
  limit?: number;
}

interface TimelineResponse {
  payload: { entries: readonly unknown[] };
}

function fitsFrameBudget(response: TimelineResponse, maxBytes: number): boolean {
  const { entries, ...payload } = response.payload;
  // Count bytes without constructing an oversized JSON string for the whole turn.
  let bytes = Buffer.byteLength(
    JSON.stringify({
      type: "session",
      message: { ...response, payload: { ...payload, entries: [] } },
    }),
  );
  for (const entry of entries) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > maxBytes) return false;
  }
  return bytes <= maxBytes;
}

export function selectTimelineResponseWithinFrameBudget<T extends TimelineResponse>(
  options: TimelineRequest & { select: (request: TimelineRequest) => T; maxBytes?: number },
): T {
  const { select, wholeTurns, maxBytes = TIMELINE_FRAME_BUDGET_BYTES } = options;
  let { limit } = options;
  const requested = select({ wholeTurns, limit });
  // Preserve whole-turn pages that fit and the existing explicit full-read contract.
  if (wholeTurns !== true || limit === 0 || fitsFrameBudget(requested, maxBytes)) return requested;

  let previousCount = Infinity;
  for (;;) {
    // Reselect using the original direction and cursor; slicing the old response
    // would keep the wrong fences and hide the skipped entries from scrollback.
    const page = select({ wholeTurns: false, limit });
    if (fitsFrameBudget(page, maxBytes)) return page;
    const count = page.payload.entries.length;
    // A tail page must start at the first row of the source span it lands in.
    // When one item's updates span the page, a smaller limit returns the same rows.
    if (count >= previousCount) {
      throw new Error(
        "One item spans more than the response size limit, so the timeline page cannot shrink.",
      );
    }
    if (count <= 1) {
      throw new Error("A timeline item exceeds the response size limit.");
    }
    previousCount = count;
    limit = Math.floor(Math.min(limit ?? count, count) / 2);
  }
}
