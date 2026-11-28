import { describe, expect, test } from "vitest";

import { isPathWithinRoot } from "./path-utils.js";

describe("isPathWithinRoot", () => {
  test("accepts the filesystem root as the parent", () => {
    expect(isPathWithinRoot("/", "/repo")).toBe(true);
  });

  test("accepts the root itself", () => {
    expect(isPathWithinRoot("/", "/")).toBe(true);
  });

  test("accepts a descendant of a normal directory", () => {
    expect(isPathWithinRoot("/work/repo", "/work/repo/src")).toBe(true);
  });

  test("rejects a sibling that shares a name prefix", () => {
    expect(isPathWithinRoot("/work/repo", "/work/repo2")).toBe(false);
  });

  test("rejects a parent directory", () => {
    expect(isPathWithinRoot("/work/repo/src", "/work/repo")).toBe(false);
  });

  test("rejects a path that escapes with ..", () => {
    expect(isPathWithinRoot("/work/repo", "/work/repo/../other")).toBe(false);
  });

  test.runIf(process.platform === "win32")("accepts a Windows drive root as the parent", () => {
    expect(isPathWithinRoot("D:\\", "D:\\repo")).toBe(true);
  });

  test.runIf(process.platform === "win32")("compares Windows paths case-insensitively", () => {
    expect(isPathWithinRoot("D:\\Repo", "d:\\repo\\src")).toBe(true);
  });

  test.runIf(process.platform === "win32")("rejects a different drive", () => {
    expect(isPathWithinRoot("D:\\", "C:\\repo")).toBe(false);
  });
});
