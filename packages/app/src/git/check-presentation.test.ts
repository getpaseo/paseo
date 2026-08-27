import { describe, expect, it } from "vitest";
import { classifyCheck, countCheckPresentations } from "./check-presentation";

describe("check presentation", () => {
  it.each([
    [{ status: "failure", traits: ["warning", "action_required"] }, "actionRequired"],
    [{ status: "pending", traits: ["manual", "action_required"] }, "actionRequired"],
    [{ status: "success", traits: ["action_required"] }, "actionRequired"],
    [{ status: "success", traits: ["warning"] }, "warning"],
    [{ status: "skipped", traits: ["manual"] }, "manual"],
    [{ status: "success" }, "success"],
    [{ status: "failure" }, "failure"],
    [{ status: "skipped" }, "ignored"],
    [{ status: "cancelled" }, "ignored"],
    [{ status: "pending" }, "pending"],
    [{ status: "success", traits: ["future-forge-trait"] }, "success"],
    [{ status: "future-provider-state" }, "pending"],
  ] as const)("classifies %o as %s", (check, expected) => {
    expect(classifyCheck(check)).toBe(expected);
  });

  it("counts mutually exclusive presentation categories", () => {
    expect(
      countCheckPresentations([
        { status: "success" },
        { status: "failure" },
        { status: "success", traits: ["warning"] },
        { status: "pending", traits: ["action_required"] },
        { status: "pending" },
        { status: "skipped", traits: ["manual"] },
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
