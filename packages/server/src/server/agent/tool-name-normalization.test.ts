import { describe, expect, it } from "vitest";

import { getPaseoToolLeafName, isPaseoToolName } from "./tool-name-normalization.js";

describe("isPaseoToolName", () => {
  it("detects Claude Code format", () => {
    expect(isPaseoToolName("mcp__paseo__create_agent")).toBe(true);
    expect(isPaseoToolName("mcp__paseo__list_agents")).toBe(true);
  });

  it("detects paseo_voice variant", () => {
    expect(isPaseoToolName("mcp__paseo_voice__create_agent")).toBe(true);
    expect(isPaseoToolName("paseo_voice.create_agent")).toBe(true);
  });

  it("excludes speak tools", () => {
    expect(isPaseoToolName("mcp__paseo_voice__speak")).toBe(false);
    expect(isPaseoToolName("mcp__paseo__speak")).toBe(false);
    expect(isPaseoToolName("paseo.speak")).toBe(false);
  });

  it("detects Codex dot format", () => {
    expect(isPaseoToolName("paseo.create_agent")).toBe(true);
  });

  it("rejects non-paseo tools", () => {
    expect(isPaseoToolName("Bash")).toBe(false);
    expect(isPaseoToolName("Read")).toBe(false);
    expect(isPaseoToolName("mcp__other_server__some_tool")).toBe(false);
  });
});

describe("getPaseoToolLeafName", () => {
  it("extracts leaf from Claude Code format", () => {
    expect(getPaseoToolLeafName("mcp__paseo__create_agent")).toBe("create_agent");
  });

  it("extracts leaf from Codex format", () => {
    expect(getPaseoToolLeafName("paseo.create_agent")).toBe("create_agent");
    expect(getPaseoToolLeafName("paseo.list_agents")).toBe("list_agents");
  });

  it("returns null for non-paseo tools", () => {
    expect(getPaseoToolLeafName("Bash")).toBeNull();
  });
});
