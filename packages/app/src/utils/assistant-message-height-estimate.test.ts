import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import {
  clearAssistantMessageHeightEstimateCache,
  estimateAssistantMessageHeightFromCache,
  setAssistantMessageHeight,
} from "./assistant-message-height-estimate";
describe("assistant message height estimate", () => {
  beforeEach(() => {
    clearAssistantMessageHeightEstimateCache();
  });

  it("uses a whole-message measurement only at the measured width", () => {
    setAssistantMessageHeight({
      markdown: "First\n\nSecond",
      width: DEFAULT_CONTENT_MAX_WIDTH,
      height: 97,
    });
    expect(
      estimateAssistantMessageHeightFromCache({
        markdown: "First\n\nSecond",
        contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
      }),
    ).toBe(97);
    expect(
      estimateAssistantMessageHeightFromCache({
        markdown: "First\n\nSecond",
        contentMaxWidth: 1600,
      }),
    ).toBeNull();
  });
});
