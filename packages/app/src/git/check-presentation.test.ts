import { describe, expect, it } from "vitest";
import {
  classifyCheck,
  countCheckPresentations,
  formatCheckPresentationCountsLabel,
} from "./check-presentation";

describe("check presentation", () => {
  it.each([
    [{ status: "failure", rawStatus: "warning", requiresAction: true }, "actionRequired"],
    [{ status: "pending", isManual: true, requiresAction: true }, "actionRequired"],
    [{ status: "success", requiresAction: true }, "actionRequired"],
    [{ status: "failure", rawStatus: "warning" }, "warning"],
    [{ status: "skipped", isManual: true }, "manual"],
    [{ status: "success" }, "success"],
    [{ status: "failure" }, "failure"],
    [{ status: "skipped" }, "ignored"],
    [{ status: "cancelled" }, "ignored"],
    [{ status: "pending" }, "pending"],
    [{ status: "future-provider-state" }, "pending"],
  ] as const)("classifies %o as %s", (check, expected) => {
    expect(classifyCheck(check)).toBe(expected);
  });

  it("counts mutually exclusive presentation categories", () => {
    expect(
      countCheckPresentations([
        { status: "success" },
        { status: "failure" },
        { status: "failure", rawStatus: "warning" },
        { status: "pending", requiresAction: true },
        { status: "pending" },
        { status: "skipped", isManual: true },
        { status: "skipped" },
      ]),
    ).toEqual({
      passed: 1,
      failed: 1,
      warnings: 1,
      actionRequired: 1,
      manual: 1,
      pending: 1,
    });
  });

  it("formats an accessible label without empty categories", () => {
    expect(
      formatCheckPresentationCountsLabel(
        { passed: 2, failed: 0, warnings: 1, actionRequired: 1, manual: 1, pending: 0 },
        {
          heading: "Checks",
          passed: "Passed: 2",
          failed: "Failed: 0",
          warnings: "Warnings: 1",
          actionRequired: "Action required: 1",
          manual: "Manual: 1",
          pending: "Pending: 0",
        },
      ),
    ).toBe("Checks, Passed: 2, Warnings: 1, Action required: 1, Manual: 1");
  });
});
