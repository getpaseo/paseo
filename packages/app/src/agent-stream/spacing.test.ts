import { describe, expect, it } from "vitest";
import {
  getAssistantMessageSpacing,
  getGapAboveTurnSummary,
  getGapBetweenStreamItems,
} from "./spacing";
import type { StreamItem } from "@/types/stream";
const message: StreamItem = {
  kind: "assistant_message",
  id: "m",
  text: "First\n\nSecond",
  timestamp: new Date(0),
};
const prompt: StreamItem = {
  kind: "user_message",
  id: "p",
  text: "Fix it",
  timestamp: new Date(0),
};
const thought: StreamItem = {
  kind: "thought",
  id: "t",
  text: "Reading",
  timestamp: new Date(0),
  status: "ready",
};
describe("whole-message spacing", () => {
  it("compacts only the gap to its turn footer", () => {
    expect(getAssistantMessageSpacing({ item: message })).toBe("default");
    expect(getAssistantMessageSpacing({ item: message, hasFooterBelow: true })).toBe(
      "compactBottom",
    );
  });
  it("keeps separate messages separated", () => {
    expect(getGapBetweenStreamItems(message, { ...message, id: "next" })).toBeGreaterThan(0);
  });
  it("sets a prompt as far above its reply and its turn's summary line as above a tool row", () => {
    const belowPrompt = getGapBetweenStreamItems(prompt, thought);
    expect(belowPrompt).toBeGreaterThan(0);
    expect(getGapBetweenStreamItems(prompt, message)).toBe(belowPrompt);
    expect(getGapAboveTurnSummary(prompt)).toBe(belowPrompt);
  });
  it("keeps a summary line hosted by a tool row flush, like the tool rows it stands for", () => {
    expect(getGapAboveTurnSummary(thought)).toBe(getGapBetweenStreamItems(thought, thought));
  });
});
