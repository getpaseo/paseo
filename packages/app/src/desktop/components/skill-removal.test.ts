import { describe, expect, it } from "vitest";
import { skillsRemovedBySave } from "./skill-removal";

const AVAILABLE = ["paseo", "paseo-advisor", "paseo-loop"];

describe("skillsRemovedBySave", () => {
  it("names an installed skill the draft drops", () => {
    expect(
      skillsRemovedBySave({
        draft: { mode: "custom", skills: ["paseo"] },
        available: AVAILABLE,
        installed: ["paseo", "paseo-loop"],
      }),
    ).toEqual(["paseo-loop"]);
  });

  it("names a skill on disk that the draft never selected", () => {
    // The saved preference is irrelevant: the host deletes whatever is installed
    // and not desired, including a directory put back by hand.
    expect(
      skillsRemovedBySave({
        draft: { mode: "custom", skills: ["paseo", "paseo-advisor"] },
        available: AVAILABLE,
        installed: ["paseo", "paseo-loop"],
      }),
    ).toEqual(["paseo-loop"]);
  });

  it("names a retired skill that the bundle no longer ships", () => {
    expect(
      skillsRemovedBySave({
        draft: { mode: "all" },
        available: AVAILABLE,
        installed: ["paseo", "paseo-chat"],
      }),
    ).toEqual(["paseo-chat"]);
  });

  it("removes nothing when every installed skill is kept", () => {
    expect(
      skillsRemovedBySave({
        draft: { mode: "all" },
        available: AVAILABLE,
        installed: ["paseo", "paseo-loop"],
      }),
    ).toEqual([]);
  });

  it("removes nothing when the draft only adds skills", () => {
    expect(
      skillsRemovedBySave({
        draft: { mode: "custom", skills: ["paseo", "paseo-loop"] },
        available: AVAILABLE,
        installed: ["paseo"],
      }),
    ).toEqual([]);
  });

  it("removes nothing when nothing is installed", () => {
    expect(
      skillsRemovedBySave({
        draft: { mode: "custom", skills: [] },
        available: AVAILABLE,
        installed: [],
      }),
    ).toEqual([]);
  });

  it("names every installed skill when the draft keeps none", () => {
    expect(
      skillsRemovedBySave({
        draft: { mode: "custom", skills: [] },
        available: AVAILABLE,
        installed: ["paseo", "paseo-advisor"],
      }),
    ).toEqual(["paseo", "paseo-advisor"]);
  });
});
