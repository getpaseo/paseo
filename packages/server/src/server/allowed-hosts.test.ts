import { describe, it, expect } from "vitest";
import { isHostAllowed, mergeAllowedHosts, parseAllowedHostsEnv } from "./allowed-hosts.js";

describe("allowed hosts (vite-style)", () => {
  it("allows localhost by default", () => {
    expect(isHostAllowed("localhost:6767", undefined)).toBe(true);
  });

  it("allows subdomains of .localhost by default", () => {
    expect(isHostAllowed("foo.localhost:6767", undefined)).toBe(true);
  });

  it("allows IP addresses by default", () => {
    expect(isHostAllowed("127.0.0.1:6767", undefined)).toBe(true);
    expect(isHostAllowed("[::1]:6767", undefined)).toBe(true);
  });

  it("rejects non-default hosts when no allowlist is provided", () => {
    expect(isHostAllowed("evil.com:6767", undefined)).toBe(false);
  });

  it("allows any host when set to true", () => {
    expect(isHostAllowed("evil.com:6767", true)).toBe(true);
  });

  it("supports leading-dot patterns", () => {
    const allowed = [".example.com"];
    expect(isHostAllowed("example.com:6767", allowed)).toBe(true);
    expect(isHostAllowed("foo.example.com:6767", allowed)).toBe(true);
    expect(isHostAllowed("foo.bar.example.com:6767", allowed)).toBe(true);
    expect(isHostAllowed("notexample.com:6767", allowed)).toBe(false);
  });

  it("merges arrays (append + de-dupe) and short-circuits on true", () => {
    expect(mergeAllowedHosts([["a"], ["a", "b"]])).toEqual(["a", "b"]);
    expect(mergeAllowedHosts([["a"], true, ["b"]])).toBe(true);
  });

  it("parses env var values", () => {
    expect(parseAllowedHostsEnv(undefined)).toBeUndefined();
    expect(parseAllowedHostsEnv("")).toBeUndefined();
    expect(parseAllowedHostsEnv("true")).toBe(true);
    expect(parseAllowedHostsEnv("localhost,.example.com")).toEqual(["localhost", ".example.com"]);
  });
});

