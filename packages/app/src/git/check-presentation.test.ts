import { describe, expect, it } from "vitest";
import { classifyCheck, countCheckPresentations } from "./check-presentation";

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
      success: 1,
      failure: 1,
      warning: 1,
      actionRequired: 1,
      manual: 1,
      pending: 1,
    });
  });
});
