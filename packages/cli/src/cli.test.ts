import { describe, expect, it } from "vitest";
import { resolveHostnamesOption } from "./cli.js";

describe("resolveHostnamesOption", () => {
  it("returns hostnames when it is a string", () => {
    expect(resolveHostnamesOption("example.com", undefined)).toBe("example.com");
  });

  it("falls back to allowedHosts when hostnames is not a string", () => {
    expect(resolveHostnamesOption(undefined, "fallback.com")).toBe("fallback.com");
  });

  it("prefers hostnames over allowedHosts when both are strings", () => {
    expect(resolveHostnamesOption("primary.com", "fallback.com")).toBe("primary.com");
  });

  it("returns undefined when neither value is a string", () => {
    expect(resolveHostnamesOption(undefined, undefined)).toBeUndefined();
    expect(resolveHostnamesOption(123, true)).toBeUndefined();
    expect(resolveHostnamesOption({}, [])).toBeUndefined();
  });
});
