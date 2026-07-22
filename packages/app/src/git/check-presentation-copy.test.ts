import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  formatCheckPresentationCountsLabel,
  getCheckPresentationStatusLabel,
} from "./check-presentation-copy";

describe("check presentation copy", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("formats counts in canonical presentation order and omits empty categories", () => {
    expect(
      formatCheckPresentationCountsLabel(
        {
          success: 2,
          failure: 0,
          warning: 1,
          actionRequired: 1,
          manual: 1,
          pending: 0,
        },
        "Checks",
        i18n.t,
      ),
    ).toBe("Checks, Passed: 2, Warnings: 1, Action required: 1, Manual: 1");
  });

  it("uses presentation policy for row status labels", () => {
    expect(
      getCheckPresentationStatusLabel({ status: "failure", rawStatus: "warning" }, i18n.t),
    ).toBe("Warning");
    expect(
      getCheckPresentationStatusLabel({ status: "cancelled", rawStatus: "cancelled" }, i18n.t),
    ).toBe("Cancelled");
  });
});
