import { describe, expect, test } from "vitest";
import { matchesPolicyPath, policyPathsChanged } from "./policy-paths.js";

describe("policy path matching", () => {
  test("a trailing slash names a directory and everything under it", () => {
    expect(matchesPolicyPath("src/auth/roles.ts", ["src/auth/"])).toBe(true);
    expect(matchesPolicyPath("src/authz/roles.ts", ["src/auth/"])).toBe(false);
  });

  test("a plain path is that file, or a directory of that name", () => {
    expect(matchesPolicyPath("policy.yaml", ["policy.yaml"])).toBe(true);
    expect(matchesPolicyPath("config/policy.yaml", ["policy.yaml"])).toBe(false);
    expect(matchesPolicyPath("src/auth/roles.ts", ["src/auth"])).toBe(true);
    expect(matchesPolicyPath("src/authz/roles.ts", ["src/auth"])).toBe(false);
  });

  test("* stays inside one folder and ** crosses folders", () => {
    expect(matchesPolicyPath("src/auth/roles.ts", ["src/*/roles.ts"])).toBe(true);
    expect(matchesPolicyPath("src/a/b/roles.ts", ["src/*/roles.ts"])).toBe(false);
    expect(matchesPolicyPath("src/a/b/roles.ts", ["src/**/roles.ts"])).toBe(true);
    expect(matchesPolicyPath("src/roles.ts", ["src/**/roles.ts"])).toBe(true);
    expect(matchesPolicyPath("a/b/c.policy.json", ["**/*.policy.json"])).toBe(true);
  });

  test("dots in a pattern are literal and a leading ./ is ignored", () => {
    expect(matchesPolicyPath("rolesxts", ["roles.ts"])).toBe(false);
    expect(matchesPolicyPath("./src/a.ts", ["/src/a.ts"])).toBe(true);
  });

  test("reports only the matching paths", () => {
    expect(policyPathsChanged(["a.ts", "acl/x.ts", "b.ts"], ["acl/"])).toEqual(["acl/x.ts"]);
    expect(policyPathsChanged(["a.ts"], [])).toEqual([]);
  });
});
