import { describe, expect, it } from "vitest";
import type { CheckStatus } from "./check-status";
import { summarizeChecks } from "./checks-summary";
import type { PrPaneCheck } from "./data";

function check(name: string, status: CheckStatus): PrPaneCheck {
  return { provider: "github", name, status, url: `https://example.test/${name}` };
}

describe("summarizeChecks", () => {
  it("reports no checks without claiming the run passed", () => {
    const summary = summarizeChecks([]);

    expect(summary.outcome).toBe("none");
    expect(summary.headline).toBe("No checks");
    expect(summary.detail).toBe("");
    expect(summary.groups).toEqual([]);
  });

  it("leads with failures when anything failed", () => {
    const summary = summarizeChecks([
      check("build", "success"),
      check("lint", "failure"),
      check("e2e", "pending"),
    ]);

    expect(summary.outcome).toBe("failure");
    expect(summary.headline).toBe("Some checks were not successful");
    expect(summary.detail).toBe("1 failing, 1 in progress, 1 successful checks");
    expect(summary.groups.map((group) => group.status)).toEqual(["failure", "pending", "success"]);
  });

  it("reports an unfinished run as in progress when nothing failed", () => {
    const summary = summarizeChecks([check("build", "success"), check("e2e", "pending")]);

    expect(summary.outcome).toBe("pending");
    expect(summary.headline).toBe("Some checks haven't completed yet");
    expect(summary.detail).toBe("1 in progress, 1 successful checks");
  });

  it("treats a run of only successes and skips as passed", () => {
    const summary = summarizeChecks([check("build", "success"), check("deploy", "skipped")]);

    expect(summary.outcome).toBe("success");
    expect(summary.headline).toBe("All checks have passed");
    expect(summary.detail).toBe("1 successful, 1 skipped checks");
  });

  it("keeps the checks of each group together under a counted label", () => {
    const summary = summarizeChecks([
      check("build", "failure"),
      check("lint", "success"),
      check("test", "failure"),
    ]);

    const [failing, successful] = summary.groups;
    expect(failing?.label).toBe("2 failing checks");
    expect(failing?.checks.map((item) => item.name)).toEqual(["build", "test"]);
    expect(successful?.label).toBe("1 successful check");
  });

  it("says check rather than checks for a run of one", () => {
    const summary = summarizeChecks([check("build", "failure")]);

    expect(summary.countNoun).toBe("check");
    expect(summary.detail).toBe("1 failing check");
  });
});
