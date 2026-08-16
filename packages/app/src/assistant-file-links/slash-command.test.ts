import { describe, expect, it } from "vitest";
import { appendSlashCommandToken, parseSlashCommandToken } from "./slash-command";

describe("parseSlashCommandToken", () => {
  it("extracts a bare command name", () => {
    expect(parseSlashCommandToken("/autoplan")).toBe("autoplan");
    expect(parseSlashCommandToken("  /autoplan  ")).toBe("autoplan");
  });

  it("allows namespaced and dashed/underscored names", () => {
    expect(parseSlashCommandToken("/a-b:c")).toBe("a-b:c");
    expect(parseSlashCommandToken("/gstack:browse")).toBe("gstack:browse");
    expect(parseSlashCommandToken("/code_review")).toBe("code_review");
  });

  it("rejects multi-segment paths", () => {
    expect(parseSlashCommandToken("/foo/bar")).toBeNull();
    expect(parseSlashCommandToken("/usr/local/bin")).toBeNull();
  });

  it("rejects filenames with extensions", () => {
    expect(parseSlashCommandToken("/foo.ts")).toBeNull();
    expect(parseSlashCommandToken("/.eslintrc")).toBeNull();
  });

  it("rejects tokens that are not a single leading-slash name", () => {
    expect(parseSlashCommandToken("/")).toBeNull();
    expect(parseSlashCommandToken("autoplan")).toBeNull();
    expect(parseSlashCommandToken("/auto plan")).toBeNull();
    expect(parseSlashCommandToken("")).toBeNull();
  });
});

describe("appendSlashCommandToken", () => {
  it("inserts into empty text with a trailing space", () => {
    expect(appendSlashCommandToken({ text: "", token: "/autoplan" })).toBe("/autoplan ");
  });

  it("adds a separating space when text does not end in whitespace", () => {
    expect(appendSlashCommandToken({ text: "run", token: "/autoplan" })).toBe("run /autoplan ");
  });

  it("does not double-space when text already ends in whitespace", () => {
    expect(appendSlashCommandToken({ text: "run ", token: "/autoplan" })).toBe("run /autoplan ");
    expect(appendSlashCommandToken({ text: "run\n", token: "/autoplan" })).toBe("run\n/autoplan ");
  });
});
