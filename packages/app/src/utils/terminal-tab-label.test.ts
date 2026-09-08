import { describe, expect, it } from "vitest";
import { resolveTerminalTabLabel } from "@/utils/terminal-tab-label";

describe("resolveTerminalTabLabel", () => {
  it("prefers a live title, then name", () => {
    expect(
      resolveTerminalTabLabel({
        title: "npm test",
        name: "Shell",
        rememberedLabel: "old",
        fallback: "Terminal",
      }),
    ).toEqual({ label: "npm test", rememberedLabel: "npm test" });

    expect(
      resolveTerminalTabLabel({
        title: "  ",
        name: "Shell",
        rememberedLabel: null,
        fallback: "Terminal",
      }),
    ).toEqual({ label: "Shell", rememberedLabel: "Shell" });
  });

  it("keeps the remembered label when the list entry is missing", () => {
    expect(
      resolveTerminalTabLabel({
        title: null,
        name: null,
        rememberedLabel: "npm test",
        fallback: "Terminal",
      }),
    ).toEqual({ label: "npm test", rememberedLabel: "npm test" });
  });

  it("falls back only when nothing live or remembered is available", () => {
    expect(
      resolveTerminalTabLabel({
        title: undefined,
        name: undefined,
        rememberedLabel: "  ",
        fallback: "Terminal",
      }),
    ).toEqual({ label: "Terminal", rememberedLabel: null });
  });
});
