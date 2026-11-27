import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n/i18next";
import { getCompactionMarkerLabel } from "./message-compaction-label";

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

  it("names a compaction that failed or was canceled instead of calling it compacted", () => {
    expect(
      getCompactionMarkerLabel({ status: "completed", trigger: "manual", outcome: "failed" }),
    ).toBe("Compaction failed");
    expect(getCompactionMarkerLabel({ status: "completed", outcome: "canceled" })).toBe(
      "Compaction canceled",
    );
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
