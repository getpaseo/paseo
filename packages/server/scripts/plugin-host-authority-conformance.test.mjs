import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CONFORMANCE_CASE_NAMES } from "./plugin-host-authority-conformance.mjs";

const scriptPath = fileURLToPath(
  new URL("./plugin-host-authority-conformance.mjs", import.meta.url),
);

describe("plugin host authority conformance executable", () => {
  test("emits every named production-path case as passing JSON", () => {
    const output = execFileSync(process.execPath, [scriptPath], {
      cwd: path.resolve(path.dirname(scriptPath), "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cases = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(cases.map((result) => result.case)).toEqual(CONFORMANCE_CASE_NAMES);
    expect(cases.map((result) => result.ok)).toEqual(CONFORMANCE_CASE_NAMES.map(() => true));
  });
});
