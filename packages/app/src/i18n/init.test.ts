import { describe, expect, it, vi } from "vitest";
import { observeI18nInit } from "./init";

describe("observeI18nInit", () => {
  it("reports initialization failures", async () => {
    const error = new Error("init failed");
    const reportError = vi.fn();

    observeI18nInit(Promise.reject(error), reportError);
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith("[i18n] Failed to initialize", error);
  });
});
