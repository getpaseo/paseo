import { describe, expect, it, vi } from "vitest";
import { returnToTimelineTail } from "./timeline-tail-navigation";

describe("returnToTimelineTail", () => {
  it("reports a failed fetch without scrolling or rejecting", async () => {
    const scrollToBottom = vi.fn();
    const onError = vi.fn();
    const logError = vi.fn();

    await expect(
      returnToTimelineTail({
        fetchTail: () => Promise.reject(new Error("disconnected")),
        scrollToBottom,
        onError,
        logError,
      }).then(() => ({
        scrolled: scrollToBottom.mock.calls.length,
        errors: onError.mock.calls.length,
        warnings: logError.mock.calls.length,
      })),
    ).resolves.toEqual({ scrolled: 0, errors: 1, warnings: 1 });
  });
});
