import { describe, expect, it } from "vitest";
import { resolveImportCwd } from "./import.js";

describe("resolveImportCwd", () => {
  it("uses the invoking process cwd when --cwd is omitted", () => {
    expect(resolveImportCwd(undefined, "/Volumes/data/dev/rolepai")).toBe(
      "/Volumes/data/dev/rolepai",
    );
  });

  it("uses explicit --cwd when provided", () => {
    expect(resolveImportCwd(" /tmp/project ", "/Volumes/data/dev/rolepai")).toBe("/tmp/project");
  });

  it("rejects an empty explicit --cwd", () => {
    expect(() => resolveImportCwd("  ", "/Volumes/data/dev/rolepai")).toThrow(
      expect.objectContaining({
        code: "INVALID_CWD",
      }),
    );
  });
});
