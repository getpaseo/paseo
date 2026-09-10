import { describe, expect, it } from "vitest";
import { getCheckIndicators, checkLabel } from "./checks";

const check = (name: string, status: string) => ({
  name,
  status,
  url: `https://github.com/acme/repo/actions/runs/${name}`,
});
describe("PR list CI", () => {
  it("collapses all successful checks into one passing indicator", () => {
    expect(getCheckIndicators([check("build", "success"), check("test", "success")])).toEqual({
      failures: [],
      cancelled: [],
      summary: "passed",
    });
  });
  it("preserves failed checks and their links alongside running checks", () => {
    const build = check("build", "failure");
    const lint = check("lint", "failure");
    expect(
      getCheckIndicators([build, lint, check("test", "pending"), check("docs", "success")]),
    ).toEqual({ failures: [build, lint], cancelled: [], summary: "pending" });
  });
  it("does not claim success for missing, skipped, cancelled, or unrecognized checks", () => {
    expect(getCheckIndicators(undefined).summary).toBeNull();
    expect(getCheckIndicators([]).summary).toBeNull();
    expect(getCheckIndicators([check("test", "skipped")]).summary).toBe("skipped");
    expect(getCheckIndicators([check("test", "cancelled")])).toEqual({
      failures: [],
      cancelled: [check("test", "cancelled")],
      summary: null,
    });
    expect(getCheckIndicators([check("test", "new-provider-status")]).summary).toBe("pending");
  });
  it("includes the workflow name in a failed job's tooltip", () => {
    expect(checkLabel({ ...check("linux", "failure"), workflow: "Integration tests" })).toBe(
      "Integration tests / linux",
    );
  });
});
