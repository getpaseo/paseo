import { describe, expect, it } from "vitest";
import { applySlashCommand, findSlashCommand } from "./slash-commands";

describe("findSlashCommand", () => {
  it("matches known commands", () => {
    expect(findSlashCommand("/me dances")?.command.name).toBe("me");
    expect(findSlashCommand("/shrug")?.command.name).toBe("shrug");
  });
  it("ignores unknown commands", () => {
    expect(findSlashCommand("/notacommand stuff")).toBeNull();
  });
  it("ignores non-command content", () => {
    expect(findSlashCommand("just text")).toBeNull();
  });
});

describe("applySlashCommand", () => {
  it("wraps /me arg in italics", () => {
    const r = applySlashCommand("/me jumps");
    expect(r.content).toBe("_jumps_");
    expect(r.suppressed).toBe(false);
    expect(r.unknown).toBe(false);
  });
  it("appends shrug", () => {
    const r = applySlashCommand("/shrug");
    expect(r.content.includes("¯\\_(ツ)_/¯")).toBe(true);
  });
  it("flags unknown commands", () => {
    const r = applySlashCommand("/doesnotexist hi");
    expect(r.unknown).toBe(true);
    expect(r.suppressed).toBe(false);
  });
  it("passes plain text through", () => {
    const r = applySlashCommand("hello everyone");
    expect(r.content).toBe("hello everyone");
    expect(r.unknown).toBe(false);
  });
});
