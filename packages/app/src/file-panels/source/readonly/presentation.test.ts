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
});
