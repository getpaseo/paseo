import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyInvocation, isExistingDirectory, isPathLikeArg } from "./classify.js";

const knownCommands = new Set(["ls", "run", "status"]);

describe("classifyInvocation", () => {
  it("classifies no args as CLI mode", () => {
    expect(
      classifyInvocation({
        argv: [],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({ kind: "cli", argv: [] });
  });

  it("classifies flags as CLI mode", () => {
    expect(
      classifyInvocation({
        argv: ["--version"],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({ kind: "cli", argv: ["--version"] });
  });

  it("classifies known commands as CLI mode", () => {
    expect(
      classifyInvocation({
        argv: ["ls", "--json"],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({ kind: "cli", argv: ["ls", "--json"] });
  });

  it("classifies '.' as an open-project invocation", () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-dot-"));

    expect(
      classifyInvocation({
        argv: ["."],
        knownCommands,
        cwd: projectDir,
      }),
    ).toEqual({
      kind: "open-project",
      resolvedPath: projectDir,
    });
  });

  it("classifies '..' as an open-project invocation", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-parent-"));
    const childDir = path.join(parentDir, "child");
    mkdirSync(childDir);

    expect(
      classifyInvocation({
        argv: [".."],
        knownCommands,
        cwd: childDir,
      }),
    ).toEqual({
      kind: "open-project",
      resolvedPath: parentDir,
    });
  });

  it("classifies './myproject' as an open-project invocation", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-relative-"));
    const projectDir = path.join(parentDir, "myproject");
    mkdirSync(projectDir);

    expect(
      classifyInvocation({
        argv: ["./myproject"],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({
      kind: "open-project",
      resolvedPath: projectDir,
    });
  });

  it("classifies an absolute path as an open-project invocation", () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-absolute-"));

    expect(
      classifyInvocation({
        argv: [projectDir],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({
      kind: "open-project",
      resolvedPath: projectDir,
    });
  });

  it("classifies a home-relative path as an open-project invocation", () => {
    const projectDir = mkdtempSync(path.join(homedir(), "paseo-classify-home-"));
    const relativeToHome = `~/${path.basename(projectDir)}`;

    expect(
      classifyInvocation({
        argv: [relativeToHome],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({
      kind: "open-project",
      resolvedPath: projectDir,
    });
  });

  it("classifies an existing directory name as an open-project invocation", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-existing-"));
    const projectDir = path.join(parentDir, "myproject");
    mkdirSync(projectDir);

    expect(
      classifyInvocation({
        argv: ["myproject"],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({
      kind: "open-project",
      resolvedPath: projectDir,
    });
  });

  it("keeps known commands in CLI mode even when a matching directory exists", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-command-"));
    mkdirSync(path.join(parentDir, "status"));

    expect(
      classifyInvocation({
        argv: ["status"],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({
      kind: "cli",
      argv: ["status"],
    });
  });

  it("classifies nonexistent args as CLI mode", () => {
    expect(
      classifyInvocation({
        argv: ["nonexistent"],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({
      kind: "cli",
      argv: ["nonexistent"],
    });
  });
});

describe("path helpers", () => {
  it("detects path-like prefixes", () => {
    expect(isPathLikeArg(".")).toBe(true);
    expect(isPathLikeArg("..")).toBe(true);
    expect(isPathLikeArg("./project")).toBe(true);
    expect(isPathLikeArg("../project")).toBe(true);
    expect(isPathLikeArg("/tmp/project")).toBe(true);
    expect(isPathLikeArg("~")).toBe(true);
    expect(isPathLikeArg("~/project")).toBe(true);
    expect(isPathLikeArg("C:\\project")).toBe(true);
    expect(isPathLikeArg("C:/project")).toBe(true);
    expect(isPathLikeArg("\\\\server\\share")).toBe(true);
    expect(isPathLikeArg("status")).toBe(false);
  });

  it("detects existing directories relative to cwd", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-helper-"));
    const projectDir = path.join(parentDir, "project");
    mkdirSync(projectDir);

    expect(isExistingDirectory({ pathArg: "project", cwd: parentDir })).toBe(true);
    expect(isExistingDirectory({ pathArg: "missing", cwd: parentDir })).toBe(false);
  });
});
