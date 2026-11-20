import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";

describe("Git path output", () => {
  it.each(["\n", "\r\n", ""])("preserves path whitespace with delimiter %j", (delimiter) => {
    expect(parseGitRevParsePath(`/repo ${delimiter}`)).toBe("/repo ");
    expect(parseGitRevParsePath(` relative path ${delimiter}`)).toBe(" relative path ");
  });

  it.each([
    "",
    "\n",
    "\r\n",
    "--path-format=absolute\n",
    "--path-format=absolute\n/repo\n",
    "/repo\n/another\n",
    "/repo\n\n",
  ])("rejects invalid output %j", (output) => {
    expect(parseGitRevParsePath(output)).toBeNull();
  });

  it("resolves a relative path without stripping its trailing space", () => {
    expect(resolveGitRevParsePath("/base", "repo \n")).toBe(resolve("/base", "repo "));
  });
});
