import { describe, expect, test } from "vitest";
import { satisfiesVersionRange } from "./version-range.js";

describe("satisfiesVersionRange", () => {
  test.each([
    ["0.2.6", ">=0.2.6", true],
    ["0.2.5", ">=0.2.6", false],
    ["0.3.0", ">=0.2.6", true],
    ["0.2.7-beta.3", ">=0.2.6", true],
    ["0.2.6-beta.1", ">=0.2.6", false],
    ["0.2.6", "", true],
    ["0.2.6", "*", true],
    ["0.2.6", "0.2.6", true],
    ["0.2.6", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["1.4.0", "^1.2.0", true],
    ["2.0.0", "^1.2.0", false],
    ["0.2.9", "~0.2.6", true],
    ["0.3.0", "~0.2.6", false],
    ["0.2.8", ">=0.2.6 <0.3.0", true],
    ["0.3.1", ">=0.2.6 <0.3.0", false],
    ["0.4.0", ">=0.2.6 <0.3.0 || >=0.4.0", true],
    ["0.2.6", "not-a-range", false],
    // An unparseable daemon version must not mark every plugin unavailable.
    ["dev", ">=9.9.9", true],
  ])("%s against %s is %s", (version, range, expected) => {
    expect(satisfiesVersionRange(version, range)).toBe(expected);
  });
});
