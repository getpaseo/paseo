import { describe, expect, it } from "vitest";

const { hasSigningTeam } = require("./after-sign.js") as {
  hasSigningTeam: (details: string) => boolean;
};

describe("after-sign", () => {
  it("keeps Developer ID signatures intact", () => {
    expect(hasSigningTeam("Signature size=9000\nTeamIdentifier=ABCDE12345\n")).toBe(true);
  });

  it("detects Electron Builder's teamless ad-hoc signature", () => {
    expect(hasSigningTeam("Signature=adhoc\nTeamIdentifier=not set\n")).toBe(false);
  });
});
