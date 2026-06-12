import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import { findEnvKey, prependEnvPath, repoCommandBinPathOverlay } from "./env-path.js";

describe("prependEnvPath", () => {
  test("prepends a new entry", () => {
    expect(prependEnvPath(["/usr/bin", "/bin"].join(delimiter), "/opt/x")).toBe(
      ["/opt/x", "/usr/bin", "/bin"].join(delimiter),
    );
  });

  test("keeps existing order when the entry is already present", () => {
    const existing = ["/opt/x", "/usr/bin"].join(delimiter);
    expect(prependEnvPath(existing, "/opt/x")).toBe(existing);
  });

  test("handles an empty existing value", () => {
    expect(prependEnvPath(undefined, "/opt/x")).toBe("/opt/x");
    expect(prependEnvPath("", "/opt/x")).toBe("/opt/x");
  });
});

describe("findEnvKey", () => {
  test("finds the Windows-cased Path key", () => {
    expect(findEnvKey({ Path: "C:\\Windows" }, "PATH")).toBe("Path");
  });

  test("falls back to the requested key when absent", () => {
    expect(findEnvKey({ HOME: "/home/user" }, "PATH")).toBe("PATH");
  });

  test("prefers an exact key match when multiple casings exist", () => {
    expect(findEnvKey({ Path: "/b", PATH: "/a" }, "PATH")).toBe("PATH");
  });
});

describe("repoCommandBinPathOverlay", () => {
  const binDir = join("/repo", "node_modules", ".bin");

  test("prepends <cwd>/node_modules/.bin to PATH", () => {
    const overlay = repoCommandBinPathOverlay("/repo", { PATH: "/usr/bin" });
    expect(overlay).toEqual({ PATH: [binDir, "/usr/bin"].join(delimiter) });
  });

  test("reuses the base env's Windows-cased Path key instead of adding a duplicate", () => {
    const overlay = repoCommandBinPathOverlay("/repo", { Path: "/usr/bin" });
    expect(overlay).toEqual({ Path: [binDir, "/usr/bin"].join(delimiter) });
  });

  test("sets PATH when the base env has none", () => {
    expect(repoCommandBinPathOverlay("/repo", {})).toEqual({ PATH: binDir });
  });

  test("is idempotent", () => {
    const once = repoCommandBinPathOverlay("/repo", { PATH: "/usr/bin" });
    const twice = repoCommandBinPathOverlay("/repo", { PATH: once.PATH });
    expect(twice).toEqual(once);
  });
});
