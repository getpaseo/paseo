import { describe, expect, it } from "vitest";
import { createWorkspaceCommand } from "./index.js";
import { resolveWorkspaceTitle } from "./rename.js";

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("workspace rename title", () => {
  it("trims the requested title", () => {
    expect(resolveWorkspaceTitle({ title: "  Fix login  " })).toBe("Fix login");
  });

  it("clears the title when resetting to the derived name", () => {
    expect(resolveWorkspaceTitle({ reset: true })).toBeNull();
  });

  it("rejects a reset that also carries a title", () => {
    expect(
      catchError(() => resolveWorkspaceTitle({ title: "Fix login", reset: true })),
    ).toMatchObject({ code: "INVALID_OPTIONS" });
    // An explicit empty title is still a title the caller passed, not a reset.
    expect(catchError(() => resolveWorkspaceTitle({ title: "", reset: true }))).toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });

  it("requires a non-empty title when not resetting", () => {
    expect(catchError(() => resolveWorkspaceTitle({}))).toMatchObject({ code: "MISSING_TITLE" });
    expect(catchError(() => resolveWorkspaceTitle({ title: "   " }))).toMatchObject({
      code: "MISSING_TITLE",
    });
  });
});

describe("workspace rename arguments", () => {
  function parseRename(argv: string[]): unknown {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "rename")?.exitOverride();
    return catchError(() => workspace.parse(argv, { from: "user" }));
  }

  it("rejects an unquoted multi-word title instead of dropping words", () => {
    expect(parseRename(["rename", "ws-1", "Auth", "rework"])).toMatchObject({
      code: "commander.excessArguments",
    });
  });
});
