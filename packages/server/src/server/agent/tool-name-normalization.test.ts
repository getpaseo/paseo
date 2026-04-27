import { describe, expect, it } from "vitest";

import { getHubcodeToolLeafName, isHubcodeToolName } from "./tool-name-normalization.js";

describe("isHubcodeToolName", () => {
  it("detects Claude Code format", () => {
    expect(isHubcodeToolName("mcp__hubcode__create_agent")).toBe(true);
    expect(isHubcodeToolName("mcp__hubcode__list_agents")).toBe(true);
  });

  it("detects hubcode_voice variant", () => {
    expect(isHubcodeToolName("mcp__hubcode_voice__create_agent")).toBe(true);
    expect(isHubcodeToolName("hubcode_voice.create_agent")).toBe(true);
  });

  it("excludes speak tools", () => {
    expect(isHubcodeToolName("mcp__hubcode_voice__speak")).toBe(false);
    expect(isHubcodeToolName("mcp__hubcode__speak")).toBe(false);
    expect(isHubcodeToolName("hubcode.speak")).toBe(false);
  });

  it("detects Codex dot format", () => {
    expect(isHubcodeToolName("hubcode.create_agent")).toBe(true);
  });

  it("rejects non-hubcode tools", () => {
    expect(isHubcodeToolName("Bash")).toBe(false);
    expect(isHubcodeToolName("Read")).toBe(false);
    expect(isHubcodeToolName("mcp__other_server__some_tool")).toBe(false);
  });
});

describe("getHubcodeToolLeafName", () => {
  it("extracts leaf from Claude Code format", () => {
    expect(getHubcodeToolLeafName("mcp__hubcode__create_agent")).toBe("create_agent");
  });

  it("extracts leaf from Codex format", () => {
    expect(getHubcodeToolLeafName("hubcode.create_agent")).toBe("create_agent");
    expect(getHubcodeToolLeafName("hubcode.list_agents")).toBe("list_agents");
  });

  it("returns null for non-hubcode tools", () => {
    expect(getHubcodeToolLeafName("Bash")).toBeNull();
  });
});
