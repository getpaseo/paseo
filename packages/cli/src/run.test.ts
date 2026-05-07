import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCliParseArgv } from "./run";

describe("runCli", () => {
  it("defaults an empty CLI invocation to onboard", () => {
    expect(
      createCliParseArgv({
        argv: [],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard"]);
  });

  it("preserves known CLI command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["daemon", "set-password"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "daemon", "set-password"]);
  });

  it("classifies existing unknown directories as open-project invocations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-"));
    const project = path.join(root, "project");
    mkdirSync(project);

    try {
      expect(
        createCliParseArgv({
          argv: ["project"],
          cwd: root,
          nodeArgv: ["node", "paseo"],
        }),
      ).toEqual({
        kind: "open-project",
        resolvedPath: project,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
