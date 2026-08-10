import { describe, expect, it } from "vitest";
import {
  getPlanImplementModes,
  getPlanImplementModeScope,
  resolvePlanImplementMode,
} from "./plan-implement-modes";

const OFFERED = [
  { id: "default", label: "Always Ask" },
  { id: "acceptEdits", label: "Accept File Edits" },
  { id: "auto", label: "Auto mode" },
  { id: "bypassPermissions", label: "Bypass" },
];

describe("getPlanImplementModes", () => {
  it("returns the modes a plan request offers", () => {
    expect(getPlanImplementModes({ metadata: { implementModes: OFFERED } })).toEqual(OFFERED);
  });

  it("drops entries that are not a well-formed mode", () => {
    expect(
      getPlanImplementModes({
        metadata: {
          implementModes: [
            { id: "default", label: "Always Ask" },
            { id: "", label: "Blank" },
            { id: "acceptEdits" },
            "acceptEdits",
            null,
            { id: "auto", label: "Auto mode" },
          ],
        },
      }),
    ).toEqual([
      { id: "default", label: "Always Ask" },
      { id: "auto", label: "Auto mode" },
    ]);
  });

  it("returns nothing when the daemon sends no modes", () => {
    // An older daemon, or a provider that does not change mode on plan approval.
    expect(getPlanImplementModes({ metadata: undefined })).toEqual([]);
    expect(getPlanImplementModes({ metadata: { planText: "- do the thing" } })).toEqual([]);
    expect(getPlanImplementModes({ metadata: { implementModes: "acceptEdits" } })).toEqual([]);
  });

  it("returns nothing when a single mode is offered, so no picker appears", () => {
    expect(
      getPlanImplementModes({ metadata: { implementModes: [{ id: "auto", label: "Auto mode" }] } }),
    ).toEqual([]);
  });
});

describe("resolvePlanImplementMode", () => {
  it("keeps the remembered mode when it is still offered", () => {
    expect(resolvePlanImplementMode(OFFERED, "auto")).toEqual({ id: "auto", label: "Auto mode" });
  });

  it("falls back to Accept File Edits when the remembered mode is no longer offered", () => {
    const withoutAuto = OFFERED.filter((mode) => mode.id !== "auto");
    expect(resolvePlanImplementMode(withoutAuto, "auto")).toEqual({
      id: "acceptEdits",
      label: "Accept File Edits",
    });
  });

  it("falls back to Accept File Edits when no mode has ever been chosen", () => {
    expect(resolvePlanImplementMode(OFFERED, null)).toEqual({
      id: "acceptEdits",
      label: "Accept File Edits",
    });
  });

  it("falls back to the first offered mode when Accept File Edits is missing", () => {
    expect(resolvePlanImplementMode([{ id: "auto", label: "Auto mode" }], "gone")).toEqual({
      id: "auto",
      label: "Auto mode",
    });
  });

  it("resolves nothing while the remembered mode is still loading", () => {
    expect(resolvePlanImplementMode(OFFERED, undefined)).toBeNull();
  });

  it("resolves nothing when no modes are offered", () => {
    expect(resolvePlanImplementMode([], "auto")).toBeNull();
  });
});

describe("getPlanImplementModeScope", () => {
  it("scopes to the project so every worktree of a repo shares one answer", () => {
    expect(
      getPlanImplementModeScope({
        projectKey: "remote:github.com/getpaseo/paseo",
        cwd: "/Users/me/worktrees/feature-a",
      }),
    ).toBe("remote:github.com/getpaseo/paseo");
    expect(
      getPlanImplementModeScope({
        projectKey: "remote:github.com/getpaseo/paseo",
        cwd: "/Users/me/worktrees/feature-b",
      }),
    ).toBe("remote:github.com/getpaseo/paseo");
  });

  it("keeps separate projects apart", () => {
    expect(getPlanImplementModeScope({ projectKey: "/Users/me/scratch" })).not.toBe(
      getPlanImplementModeScope({ projectKey: "/Users/me/work" }),
    );
  });

  it("falls back to the checkout path when the agent has no project placement", () => {
    expect(getPlanImplementModeScope({ projectKey: null, cwd: "/Users/me/loose-dir" })).toBe(
      "/Users/me/loose-dir",
    );
    expect(getPlanImplementModeScope({ projectKey: "   ", cwd: "/Users/me/loose-dir" })).toBe(
      "/Users/me/loose-dir",
    );
  });

  it("falls back to one shared bucket when nothing identifies the agent", () => {
    expect(getPlanImplementModeScope({})).toBe("");
    expect(getPlanImplementModeScope({ projectKey: null, cwd: null })).toBe("");
  });
});
