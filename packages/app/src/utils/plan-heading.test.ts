import { describe, expect, it } from "vitest";

import { splitPlanHeading } from "./plan-heading";

describe("splitPlanHeading", () => {
  it("lifts a leading ATX heading out of the body", () => {
    const result = splitPlanHeading("# Plan: Calculate 2 + 2\n\n## Context\nDo the thing.");
    expect(result.planHeading).toBe("Plan: Calculate 2 + 2");
    expect(result.bodyText).toBe("## Context\nDo the thing.");
  });

  it("skips blank lines before the heading", () => {
    const result = splitPlanHeading("\n\n## Refactor auth\nbody");
    expect(result.planHeading).toBe("Refactor auth");
    expect(result.bodyText).toBe("body");
  });

  it("strips trailing closing hashes but keeps inner hashes", () => {
    const result = splitPlanHeading("# Title with # inside ##\nbody");
    expect(result.planHeading).toBe("Title with # inside");
    expect(result.bodyText).toBe("body");
  });

  it("returns the text unchanged when there is no heading", () => {
    const text = "- Step one\n- Step two";
    const result = splitPlanHeading(text);
    expect(result.planHeading).toBeUndefined();
    expect(result.bodyText).toBe(text);
  });

  it("does not treat a bare hash with no text as a heading", () => {
    const text = "#\nbody";
    const result = splitPlanHeading(text);
    expect(result.planHeading).toBeUndefined();
    expect(result.bodyText).toBe(text);
  });

  it("ignores headings that are not on the first content line", () => {
    const text = "Intro paragraph\n# Later heading";
    const result = splitPlanHeading(text);
    expect(result.planHeading).toBeUndefined();
    expect(result.bodyText).toBe(text);
  });

  it("returns an empty body when the plan is only a heading", () => {
    const result = splitPlanHeading("# Just a title");
    expect(result.planHeading).toBe("Just a title");
    expect(result.bodyText).toBe("");
  });
});
