import { describe, expect, it } from "vitest";
import { parseSkillsSnapshot } from "./skills-snapshot";

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
        selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
      }),
    ).toEqual({
      state: "drift",
      ops: [
        { kind: "add", name: "paseo-loop" },
        { kind: "delete", name: "paseo-chat" },
      ],
      available: ["paseo", "paseo-loop"],
      selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
    });
  });

  it("reads a snapshot with no saved selection as all skills", () => {
    expect(parseSkillsSnapshot({ state: "up-to-date", ops: [], available: ["paseo"] })).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo"],
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
      selection: { mode: "custom", skills: ["paseo"] },
    });
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
