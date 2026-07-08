import { describe, expect, test } from "vitest";

import {
  buildVoiceModeSystemPrompt,
  PASEO_MCP_SERVER_NAME,
  stripVoiceModeSystemPrompt,
  wrapSpokenInput,
} from "./voice-config.js";

describe("voice mode prompt instructions", () => {
  test("builds enabled voice instructions and preserves base prompt", () => {
    const prompt = buildVoiceModeSystemPrompt("Base system prompt", true);

    expect(prompt).toContain("Base system prompt");
    expect(prompt).toContain("<paseo_voice_mode>");
    expect(prompt).toContain("Paseo voice mode is now on.");
    expect(prompt).toContain("Always use the speak tool for all user-facing communication.");
    expect(prompt).toContain("</paseo_voice_mode>");
  });

  test("builds enabled voice instructions for the generic paseo MCP server", () => {
    const prompt = buildVoiceModeSystemPrompt("Base system prompt", true, {
      voiceToolMcpServerName: PASEO_MCP_SERVER_NAME,
    });

    expect(prompt).toContain(`Always use the ${PASEO_MCP_SERVER_NAME}.speak tool`);
    expect(prompt).toContain(`first call ${PASEO_MCP_SERVER_NAME}.speak`);
  });

  test("builds disabled voice instructions and supersedes previous voice block", () => {
    const existing = [
      "Base system prompt",
      "<paseo_voice_mode>",
      "legacy voice instruction",
      "</paseo_voice_mode>",
    ].join("\n\n");

    const prompt = buildVoiceModeSystemPrompt(existing, false);

    expect(prompt).toContain("Base system prompt");
    expect(prompt).toContain("Paseo voice mode is now off.");
    expect(prompt).toContain("Ignore any earlier Paseo voice mode instructions in this thread.");
    expect(prompt.match(/<paseo_voice_mode>/g)?.length ?? 0).toBe(1);
    expect(prompt).not.toContain("legacy voice instruction");
  });

  test("strips voice blocks from persisted prompt", () => {
    const existing = [
      "Base system prompt",
      "<paseo_voice_mode>",
      "legacy voice instruction",
      "</paseo_voice_mode>",
    ].join("\n\n");

    expect(stripVoiceModeSystemPrompt(existing)).toBe("Base system prompt");
    expect(
      stripVoiceModeSystemPrompt(
        ["<paseo_voice_mode>", "legacy voice instruction", "</paseo_voice_mode>"].join("\n\n"),
      ),
    ).toBeUndefined();
  });
});

describe("spoken-input wrapping", () => {
  test("defaults to the generic speak tool", () => {
    expect(wrapSpokenInput("hello")).toContain("Respond using the speak tool only");
  });

  test("mentions the generic paseo MCP tool when configured", () => {
    expect(
      wrapSpokenInput("hello", {
        voiceToolMcpServerName: PASEO_MCP_SERVER_NAME,
      }),
    ).toContain(`Respond using the ${PASEO_MCP_SERVER_NAME}.speak tool only`);
  });
});
