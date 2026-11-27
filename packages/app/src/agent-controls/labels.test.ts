import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "./labels";

describe("formatAgentModeLabel", () => {
  it("sentence-cases provider mode labels", () => {
    expect(formatAgentModeLabel({ id: "plan", label: "Plan" })).toBe("Plan");
    expect(formatAgentModeLabel({ id: "full-access", label: "Full Access" })).toBe("Full access");
    expect(formatAgentModeLabel({ id: "auto-review", label: "Auto-review" })).toBe("Auto-review");
    expect(formatAgentModeLabel({ id: "read_only", label: "read_only" })).toBe("Read only");
    expect(formatAgentModeLabel({ id: "acceptEdits", label: "acceptEdits" })).toBe("Accept edits");
  });

  it("splits compact mode ids when no provider label is available", () => {
    expect(formatAgentModeLabel({ id: "auto-review" })).toBe("Auto review");
  });
});

describe("formatThinkingOptionLabel", () => {
  it("formats compact thinking option labels for display", () => {
    expect(formatThinkingOptionLabel({ id: "none", label: "none" })).toBe("None");
    expect(formatThinkingOptionLabel({ id: "low", label: "low" })).toBe("Low");
    expect(formatThinkingOptionLabel({ id: "medium", label: "medium" })).toBe("Medium");
    expect(formatThinkingOptionLabel({ id: "high", label: "high" })).toBe("High");
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "xhigh" })).toBe("Extra high");
  });

  it("sentence-cases split provider labels", () => {
    expect(formatThinkingOptionLabel({ id: "extra_high", label: "extra_high" })).toBe("Extra high");
    expect(formatThinkingOptionLabel({ id: "think-hard", label: "think-hard" })).toBe("Think hard");
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "XHigh" })).toBe("Extra high");
  });

  it("preserves provider-supplied xhigh labels with extra detail", () => {
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "XHigh (56 | 8m)" })).toBe(
      "X high (56 | 8m)",
    );
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "XHigh (45 | 6m)" })).toBe(
      "X high (45 | 6m)",
    );
    expect(formatThinkingOptionLabel({ id: "xhigh" })).toBe("Extra high");
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "Extra high" })).toBe("Extra high");
  });

  it("keeps Extra high in English across non-English locales", async () => {
    const previousLanguage = i18n.language;
    const nonEnglishLocales = ["ar", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"] as const;

    try {
      for (const locale of nonEnglishLocales) {
        await i18n.changeLanguage(locale);
        expect(formatThinkingOptionLabel({ id: "xhigh", label: "xhigh" })).toBe("Extra high");
        expect(formatThinkingOptionLabel({ id: "xhigh", label: "XHigh" })).toBe("Extra high");
        expect(formatThinkingOptionLabel({ id: "xhigh" })).toBe("Extra high");
        expect(formatThinkingOptionLabel({ id: "extra_high", label: "extra_high" })).toBe(
          "Extra high",
        );
        expect(formatThinkingOptionLabel({ id: "xhigh", label: "Extra High" })).toBe("Extra high");
      }
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});
