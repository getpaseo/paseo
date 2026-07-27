import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n/i18next";
import { getCompactionMarkerLabel, getCompactionRecapPreview } from "./message-compaction-label";

describe("getCompactionMarkerLabel", () => {
  it("renders loading, automatic, manual, tokenized, and fallback labels", () => {
    expect(getCompactionMarkerLabel({ status: "loading" })).toBe("Compacting...");
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "auto" })).toBe(
      "Context automatically compacted",
    );
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "manual" })).toBe(
      "Context manually compacted",
    );
    expect(getCompactionMarkerLabel({ status: "completed", preTokens: 12_345 })).toBe(
      "Context compacted (12K tokens)",
    );
    expect(getCompactionMarkerLabel({ status: "completed" })).toBe("Context compacted");
  });

  it("renders labels in the active app language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(getCompactionMarkerLabel({ status: "loading" })).toBe("正在压缩...");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("getCompactionRecapPreview", () => {
  it("prefers a non-empty short recap", () => {
    expect(
      getCompactionRecapPreview({
        summary: "Detailed recap",
        shortSummary: "Short recap",
      }),
    ).toBe("Short recap");
  });

  it("falls back to a non-empty detailed recap", () => {
    expect(
      getCompactionRecapPreview({
        summary: "Detailed recap",
        shortSummary: "   ",
      }),
    ).toBe("Detailed recap");
  });

  it("returns null when no non-empty recap exists", () => {
    expect(getCompactionRecapPreview({})).toBeNull();
    expect(
      getCompactionRecapPreview({
        summary: "",
        shortSummary: "   ",
      }),
    ).toBeNull();
  });
});
