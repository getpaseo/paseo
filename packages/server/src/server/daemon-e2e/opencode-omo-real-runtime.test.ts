import { describe, expect, test } from "vitest";

import {
  resolveCommandLaunch,
  resolveWindowsHomeEnv,
  withArtifactLocation,
} from "./opencode-omo-real-runtime.js";

describe("resolveCommandLaunch", () => {
  test("launches Windows npm command shims through cmd.exe", () => {
    expect(resolveCommandLaunch("C:\\fixture runtime\\omo.cmd", ["install"], "win32")).toEqual({
      command: process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\fixture runtime\\omo.cmd" install'],
      shell: false,
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

test("includes retained artifacts in fixture setup failures", () => {
  expect(
    withArtifactLocation(new Error("Command timed out: npm-install.log"), "/tmp/artifacts").message,
  ).toBe("Command timed out: npm-install.log. Retained real-test artifacts: /tmp/artifacts");
});

test("isolates Windows native home resolution", () => {
  expect(resolveWindowsHomeEnv("C:\\fixture\\home", "C:\\fixture\\tmp")).toEqual({
    USERPROFILE: "C:\\fixture\\home",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\fixture\\home",
    APPDATA: "C:\\fixture\\home\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\fixture\\home\\AppData\\Local",
    TEMP: "C:\\fixture\\tmp",
    TMP: "C:\\fixture\\tmp",
  });
});
