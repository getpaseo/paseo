import { describe, expect, test } from "vitest";

import {
  AGENT_HISTORY_UNTITLED_TITLE,
  compareAgentHistoryText,
  normalizeAgentHistoryTitle,
} from "./agent-history-sort.js";

describe("agent history alphabetical sorting", () => {
  test("uses a fixed case-insensitive numeric comparator and canonical title fallback", () => {
    expect(normalizeAgentHistoryTitle("  ")).toBe(AGENT_HISTORY_UNTITLED_TITLE);
    expect(normalizeAgentHistoryTitle(null)).toBe(AGENT_HISTORY_UNTITLED_TITLE);
    expect(normalizeAgentHistoryTitle("  Session 12 ")).toBe("Session 12");
    expect(compareAgentHistoryText("session 2", "Session 10")).toBeLessThan(0);
    expect(compareAgentHistoryText("ALPHA", "alpha")).toBe(0);
  });
});
