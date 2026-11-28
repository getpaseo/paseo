import { describe, expect, it } from "vitest";
import * as gpuiBudget from "./resource-budget.gpui";

describe("resource budget per target", () => {
  it("gives desktop resource budgets on GPUI and web/Electron, and mobile budgets on iOS/Android", async () => {
    const baseBudget = (await import(
      new URL("./resource-budget.ts", import.meta.url).href
    )) as typeof gpuiBudget;

    expect(baseBudget.resolveUsesMobileResourceBudget({ isNative: true })).toBe(true);
    expect(baseBudget.resolveUsesMobileResourceBudget({ isNative: false })).toBe(false);
    expect(gpuiBudget.usesMobileResourceBudget).toBe(false);
  });
});
