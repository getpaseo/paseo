import { describe, expect, it } from "vitest";

import {
  COMPOSER_SIGIL_CHOICES,
  DEFAULT_COMMAND_SIGIL,
  DEFAULT_SKILL_SIGIL,
  MENTION_SIGIL,
  parseComposerSigil,
  resolveComposerSigils,
} from "./sigils";

describe("COMPOSER_SIGIL_CHOICES", () => {
  it("never offers the character reserved for file mentions", () => {
    expect(COMPOSER_SIGIL_CHOICES).not.toContain(MENTION_SIGIL);
  });

  it("offers more choices than there are slots, so collisions can always resolve", () => {
    expect(COMPOSER_SIGIL_CHOICES.length).toBeGreaterThan(2);
  });
});

describe("parseComposerSigil", () => {
  it("accepts an allowlisted character", () => {
    expect(parseComposerSigil("$")).toBe("$");
  });

  it("rejects anything off the allowlist", () => {
    for (const value of ["a", "1", "@", "", " ", "//", null, undefined, 7, {}]) {
      expect(parseComposerSigil(value)).toBeNull();
    }
  });
});

describe("resolveComposerSigils", () => {
  it("defaults an absent pair", () => {
    expect(resolveComposerSigils({})).toEqual({
      command: DEFAULT_COMMAND_SIGIL,
      skill: DEFAULT_SKILL_SIGIL,
    });
  });

  it("keeps a valid custom pair", () => {
    expect(resolveComposerSigils({ command: "!", skill: "#" })).toEqual({
      command: "!",
      skill: "#",
    });
  });

  it("falls back per field rather than discarding the whole pair", () => {
    expect(resolveComposerSigils({ command: "nonsense", skill: "#" })).toEqual({
      command: DEFAULT_COMMAND_SIGIL,
      skill: "#",
    });
  });

  it("breaks a collision by moving the skill sigil", () => {
    const resolved = resolveComposerSigils({ command: "$", skill: "$" });
    expect(resolved.command).toBe("$");
    expect(resolved.skill).not.toBe("$");
  });

  it("breaks a collision created by the skill default", () => {
    // Command takes `$`, so skill cannot keep its default and must move.
    const resolved = resolveComposerSigils({ command: "$" });
    expect(resolved.command).toBe("$");
    expect(resolved.skill).not.toBe("$");
  });

  it("always returns a distinct pair for every allowlisted command choice", () => {
    for (const command of COMPOSER_SIGIL_CHOICES) {
      for (const skill of COMPOSER_SIGIL_CHOICES) {
        const resolved = resolveComposerSigils({ command, skill });
        expect(resolved.command).not.toBe(resolved.skill);
      }
    }
  });
});
