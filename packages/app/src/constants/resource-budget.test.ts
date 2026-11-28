import { describe, expect, it } from "vitest";
import * as gpuiBudget from "./resource-budget.gpui";

describe("resource budget per target", () => {
  it("resolves mobile and desktop resource budget limits for iOS, Android, web, and Electron", async () => {
    const baseBudget = (await import(
      new URL("./resource-budget.ts", import.meta.url).href
    )) as typeof import("./resource-budget");

    expect(baseBudget.resolveResourceBudgets({ isNative: true })).toEqual({
      workspaceDeckRetentionLimit: 1,
      sourceFileBudgets: { highlighted: 1024 * 1024, plain: 10 * 1024 * 1024 },
      deferModelSelectorMount: true,
    });
    expect(baseBudget.resolveResourceBudgets({ isNative: false })).toEqual({
      workspaceDeckRetentionLimit: 10,
      sourceFileBudgets: { highlighted: 10 * 1024 * 1024, plain: 50 * 1024 * 1024 },
      deferModelSelectorMount: false,
    });
  });

  it("exports plain desktop-sized resource budget values on GPUI without a target resolver", () => {
    expect({
      workspaceDeckRetentionLimit: gpuiBudget.workspaceDeckRetentionLimit,
      sourceFileBudgets: gpuiBudget.sourceFileBudgets,
      deferModelSelectorMount: gpuiBudget.deferModelSelectorMount,
    }).toEqual({
      workspaceDeckRetentionLimit: 10,
      sourceFileBudgets: { highlighted: 10 * 1024 * 1024, plain: 50 * 1024 * 1024 },
      deferModelSelectorMount: false,
    });
    expect("resolveResourceBudgets" in gpuiBudget).toBe(false);
  });
});
