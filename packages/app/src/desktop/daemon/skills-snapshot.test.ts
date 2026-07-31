import { describe, expect, it } from "vitest";
import { parseSkillsSaveResult, parseSkillsSnapshot } from "./skills-snapshot";

describe("parseSkillsSnapshot", () => {
  it("parses a full snapshot from the desktop command surface", () => {
    expect(
      parseSkillsSnapshot({
        state: "drift",
        ops: [
          { kind: "add", name: "paseo-loop" },
          { kind: "delete", name: "paseo-chat" },
        ],
        available: ["paseo", "paseo-loop"],
        installed: ["paseo"],
        selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
      }),
    ).toEqual({
      state: "drift",
      ops: [
        { kind: "add", name: "paseo-loop" },
        { kind: "delete", name: "paseo-chat" },
      ],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo"],
      selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
    });
  });

  it("parses the installed skills the host reports", () => {
    expect(
      parseSkillsSnapshot({
        state: "drift",
        ops: [{ kind: "add", name: "paseo-loop" }],
        available: ["paseo", "paseo-loop"],
        installed: ["paseo-loop", 7],
        selection: { mode: "all" },
      }).installed,
    ).toEqual(["paseo-loop"]);
  });

  it("assumes the saved selection is installed when the host does not report it", () => {
    // An older host has no `installed` field. Assuming the selection is on disk
    // keeps the destructive confirmation firing rather than silently skipping it.
    expect(
      parseSkillsSnapshot({
        state: "up-to-date",
        ops: [],
        available: ["paseo", "paseo-advisor", "paseo-loop"],
        selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
      }).installed,
    ).toEqual(["paseo", "paseo-loop"]);
  });

  it("assumes every bundled skill is installed for an all selection from an older host", () => {
    expect(
      parseSkillsSnapshot({
        state: "up-to-date",
        ops: [],
        available: ["paseo", "paseo-loop"],
      }).installed,
    ).toEqual(["paseo", "paseo-loop"]);
  });

  it("reads a snapshot with no saved selection as all skills", () => {
    expect(parseSkillsSnapshot({ state: "up-to-date", ops: [], available: ["paseo"] })).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo"],
      installed: ["paseo"],
      selection: { mode: "all" },
    });
  });

  it("drops catalog and selection entries that are not skill names", () => {
    expect(
      parseSkillsSnapshot({
        state: "up-to-date",
        ops: [],
        available: ["paseo", 7, null, "paseo-loop"],
        selection: { mode: "custom", skills: ["paseo", 7] },
      }),
    ).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo"],
      selection: { mode: "custom", skills: ["paseo"] },
    });
  });

  it("reads the removals the host wants confirmed", () => {
    expect(
      parseSkillsSaveResult({
        state: "up-to-date",
        ops: [],
        available: ["paseo", "paseo-loop"],
        installed: ["paseo", "paseo-loop"],
        selection: { mode: "all" },
        confirmationRequired: { removals: ["paseo-loop", 7] },
      }).confirmationRequired,
    ).toEqual({ removals: ["paseo-loop"] });
  });

  it("treats a save with no confirmation request as applied", () => {
    expect(
      parseSkillsSaveResult({
        state: "up-to-date",
        ops: [],
        available: ["paseo"],
        installed: ["paseo"],
        selection: { mode: "all" },
      }).confirmationRequired,
    ).toBeNull();
  });

  it("rejects a response that is not an object", () => {
    expect(() => parseSkillsSnapshot("nope")).toThrow("Unexpected skills status response.");
  });

  it("rejects an unknown install state", () => {
    expect(() => parseSkillsSnapshot({ state: "half-installed", ops: [] })).toThrow(
      "Unexpected skills status state: half-installed",
    );
  });

  it("rejects an unknown pending operation kind", () => {
    expect(() =>
      parseSkillsSnapshot({ state: "drift", ops: [{ kind: "relocate", name: "paseo" }] }),
    ).toThrow("Unexpected skill op kind: relocate");
  });
});
