import { describe, expect, it } from "vitest";
import { SOURCE_PRESENTATION_BUDGETS, selectSourcePresentation } from "./presentation";

describe("selectSourcePresentation", () => {
  for (const platform of ["web", "native"] as const) {
    const budgets = SOURCE_PRESENTATION_BUDGETS[platform];
    it(`keeps ${platform} threshold edges predictable`, () => {
      expect(selectSourcePresentation({ platform, size: budgets.highlighted })).toBe("highlighted");
      expect(selectSourcePresentation({ platform, size: budgets.highlighted + 1 })).toBe("plain");
      expect(selectSourcePresentation({ platform, size: budgets.plain })).toBe("plain");
      expect(selectSourcePresentation({ platform, size: budgets.plain + 1 })).toBe("unsupported");
    });
  }

  it("defaults to the target resource budget limits when no platform override is passed", () => {
    const webBudgets = SOURCE_PRESENTATION_BUDGETS.web;
    expect(selectSourcePresentation({ size: webBudgets.highlighted })).toBe("highlighted");
    expect(selectSourcePresentation({ size: webBudgets.highlighted + 1 })).toBe("plain");
    expect(selectSourcePresentation({ size: webBudgets.plain + 1 })).toBe("unsupported");
  });
});
