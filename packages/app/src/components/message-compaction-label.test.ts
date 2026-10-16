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

  it("does not label canceled or failed compaction as successful", () => {
    expect(
      getCompactionMarkerLabel({
        status: "completed",
        trigger: "manual",
        outcome: "canceled",
        preTokens: 12000,
      }),
    ).toBe("Context compaction canceled");
    expect(
      getCompactionMarkerLabel({
        status: "completed",
        trigger: "auto",
        outcome: "failed",
        preTokens: 12000,
      }),
    ).toBe("Context compaction failed");
  });

  it("renders labels in the active app language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(getCompactionMarkerLabel({ status: "loading" })).toBe("正在压缩...");
      expect(getCompactionMarkerLabel({ status: "completed", outcome: "canceled" })).toBe(
        "上下文压缩已取消",
      );
      expect(getCompactionMarkerLabel({ status: "completed", outcome: "failed" })).toBe(
        "上下文压缩失败",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
