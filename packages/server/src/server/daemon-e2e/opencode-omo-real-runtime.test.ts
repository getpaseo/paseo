import { describe, expect, test } from "vitest";

import { resolveCommandLaunch } from "./opencode-omo-real-runtime.js";

describe("resolveCommandLaunch", () => {
  test("launches Windows npm command shims through cmd.exe", () => {
    expect(resolveCommandLaunch("C:\\fixture runtime\\omo.cmd", ["install"], "win32")).toEqual({
      command: "C:\\fixture runtime\\omo.cmd",
      args: ["install"],
      shell: true,
    });
  });

  test("launches Windows executables directly", () => {
    expect(resolveCommandLaunch("C:\\fixture runtime\\opencode.exe", [], "win32")).toEqual({
      command: "C:\\fixture runtime\\opencode.exe",
      args: [],
      shell: false,
    });
  });
});
