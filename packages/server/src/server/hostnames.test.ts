import { describe, it, expect } from "vitest";
import { PersistedConfigSchema } from "./persisted-config.js";
import { isHostnameAllowed, mergeHostnames, parseHostnamesEnv } from "./hostnames.js";

describe("hostnames (vite-style)", () => {
  it("allows localhost by default", () => {
    expect(isHostnameAllowed("localhost:6767", undefined)).toBe(true);
  });

  it("allows subdomains of .localhost by default", () => {
    expect(isHostnameAllowed("foo.localhost:6767", undefined)).toBe(true);
  });

  it("allows IP addresses by default", () => {
    expect(isHostnameAllowed("127.0.0.1:6767", undefined)).toBe(true);
    expect(isHostnameAllowed("[::1]:6767", undefined)).toBe(true);
  });

  it("rejects non-default hosts when no allowlist is provided", () => {
    expect(isHostnameAllowed("evil.com:6767", undefined)).toBe(false);
  });

  it("allows any host when set to true", () => {
    expect(isHostnameAllowed("evil.com:6767", true)).toBe(true);
  });

  it("supports leading-dot patterns", () => {
    const hostnames = [".example.com"];
    expect(isHostnameAllowed("example.com:6767", hostnames)).toBe(true);
    expect(isHostnameAllowed("foo.example.com:6767", hostnames)).toBe(true);
    expect(isHostnameAllowed("foo.bar.example.com:6767", hostnames)).toBe(true);
    expect(isHostnameAllowed("notexample.com:6767", hostnames)).toBe(false);
  });

  it("merges arrays (append + de-dupe) and short-circuits on true", () => {
    expect(mergeHostnames([["a"], ["a", "b"]])).toEqual(["a", "b"]);
    expect(mergeHostnames([["a"], true, ["b"]])).toBe(true);
  });

  it("parses env var values", () => {
    expect(parseHostnamesEnv(undefined)).toBeUndefined();
    expect(parseHostnamesEnv("")).toBeUndefined();
    expect(parseHostnamesEnv("true")).toBe(true);
    expect(parseHostnamesEnv("localhost,.example.com")).toEqual(["localhost", ".example.com"]);
  });

  it("normalizes persisted allowedHosts into hostnames for backward compatibility", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        allowedHosts: [".example.com"],
      },
    });

    expect(parsed.daemon?.hostnames).toEqual([".example.com"]);
  });
});
