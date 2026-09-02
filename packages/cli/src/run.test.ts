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

  it("routes explicit root relay flags to onboard", () => {
    expect(
      createCliParseArgv({
        argv: ["--relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--relay"]);
    expect(
      createCliParseArgv({
        argv: ["--no-relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--no-relay"]);
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

  it("preserves the hooks command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["hooks", "claude", "UserPromptSubmit"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "hooks", "claude", "UserPromptSubmit"]);
  });

  it("classifies existing unknown directories as open-project invocations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-"));
    const project = path.join(root, "repository");
    mkdirSync(project);

    try {
      expect(
        createCliParseArgv({
          argv: ["repository"],
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

  it("classifies --create with a missing directory as a create-project invocation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-create-"));
    const missingDir = path.join(root, "fresh", "project");

    try {
      expect(
        createCliParseArgv({
          argv: ["--create", missingDir],
          cwd: root,
          nodeArgv: ["node", "paseo"],
        }),
      ).toEqual({
        kind: "create-project",
        resolvedPath: missingDir,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies --create with an existing directory as an open-project invocation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-create-open-"));
    const project = path.join(root, "existing");
    mkdirSync(project);

    try {
      expect(
        createCliParseArgv({
          argv: ["--create", project],
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
