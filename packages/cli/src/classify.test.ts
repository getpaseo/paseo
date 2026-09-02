import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyInvocation,
  isExistingDirectory,
  isPathLikeArg,
  resolveCreatableDirectory,
} from "./classify.js";

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

describe("classifyInvocation --create", () => {
  it("classifies --create with a missing absolute path as create-project", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-create-"));
    const missingDir = path.join(parentDir, "newproject");

    expect(
      classifyInvocation({
        argv: ["--create", missingDir],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({
      kind: "create-project",
      resolvedPath: missingDir,
    });
  });

  it("classifies --create with a missing nested relative path as create-project", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-create-nested-"));
    const missingDir = path.join(parentDir, "deep", "nested", "project");

    expect(
      classifyInvocation({
        argv: ["--create", path.relative(parentDir, missingDir)],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({
      kind: "create-project",
      resolvedPath: missingDir,
    });
  });

  it("classifies --create with an existing directory as open-project", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-create-existing-"));
    const projectDir = path.join(parentDir, "existing");
    mkdirSync(projectDir);

    expect(
      classifyInvocation({
        argv: ["--create", projectDir],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({
      kind: "open-project",
      resolvedPath: projectDir,
    });
  });

  it("expands ~ in --create targets", () => {
    const homeRelative = "~/paseo-classify-create-home-target";

    expect(
      classifyInvocation({
        argv: ["--create", homeRelative],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({
      kind: "create-project",
      resolvedPath: path.join(homedir(), "paseo-classify-create-home-target"),
    });
  });

  it("falls back to CLI mode when --create has no target", () => {
    expect(
      classifyInvocation({
        argv: ["--create"],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({ kind: "cli", argv: ["--create"] });
  });

  it("falls back to CLI mode when the --create target is another flag", () => {
    expect(
      classifyInvocation({
        argv: ["--create", "--json"],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({ kind: "cli", argv: ["--create", "--json"] });
  });

  it("falls back to CLI mode when the --create target already exists as a file", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-create-file-"));
    const filePath = path.join(parentDir, "file.txt");
    writeFileSync(filePath, "");

    expect(
      classifyInvocation({
        argv: ["--create", filePath],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({ kind: "cli", argv: ["--create", filePath] });
  });

  it("treats an existing root target as an idempotent open-project", () => {
    expect(
      classifyInvocation({
        argv: ["--create", "/"],
        knownCommands,
        cwd: process.cwd(),
      }),
    ).toEqual({ kind: "open-project", resolvedPath: "/" });
  });

  it("keeps --create ahead of known command matching", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-create-cmd-"));
    const missingDir = path.join(parentDir, "status");

    expect(
      classifyInvocation({
        argv: ["--create", "status"],
        knownCommands,
        cwd: parentDir,
      }),
    ).toEqual({
      kind: "create-project",
      resolvedPath: missingDir,
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
    expect(isPathLikeArg("status")).toBe(false);
  });

  it("detects existing directories relative to cwd", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-helper-"));
    const projectDir = path.join(parentDir, "project");
    mkdirSync(projectDir);

    expect(isExistingDirectory({ pathArg: "project", cwd: parentDir })).toBe(true);
    expect(isExistingDirectory({ pathArg: "missing", cwd: parentDir })).toBe(false);
  });

  it("resolves creatable directories and rejects existing entries and roots", () => {
    const parentDir = mkdtempSync(path.join(tmpdir(), "paseo-classify-creatable-"));
    const existingDir = path.join(parentDir, "existing");
    mkdirSync(existingDir);
    const existingFile = path.join(parentDir, "file.txt");
    writeFileSync(existingFile, "");

    expect(resolveCreatableDirectory({ pathArg: "brand-new", cwd: parentDir })).toBe(
      path.join(parentDir, "brand-new"),
    );
    expect(resolveCreatableDirectory({ pathArg: "existing", cwd: parentDir })).toBeNull();
    expect(resolveCreatableDirectory({ pathArg: "file.txt", cwd: parentDir })).toBeNull();
    expect(resolveCreatableDirectory({ pathArg: "/", cwd: parentDir })).toBeNull();
  });
});
