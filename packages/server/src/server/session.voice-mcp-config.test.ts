import { describe, expect, test } from "vitest";

import {
  buildVoiceAgentMcpServerConfig,
  buildVoiceModeSystemPrompt,
  stripVoiceModeSystemPrompt,
  wrapSpokenInput,
} from "./voice-config.js";

describe("voice MCP stdio config", () => {
  test("builds stdio MCP config for voice agent", () => {
    const config = buildVoiceAgentMcpServerConfig({
      command: "/usr/local/bin/node",
      baseArgs: ["/tmp/mcp-stdio-socket-bridge-cli.mjs"],
      socketPath: "/tmp/paseo-voice.sock",
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PASEO_HOME: "/tmp/paseo-home",
      },
    });

    expect(config.type).toBe("stdio");
    expect(config.command).toBe("/usr/local/bin/node");
    expect(config.args).toEqual([
      "/tmp/mcp-stdio-socket-bridge-cli.mjs",
      "--socket",
      "/tmp/paseo-voice.sock",
    ]);
    expect(config.env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_HOME: "/tmp/paseo-home",
    });
  });
});

describe("voice mode prompt instructions", () => {
  test("builds enabled voice instructions and preserves base prompt", () => {
    const prompt = buildVoiceModeSystemPrompt("Base system prompt", true);

    expect(prompt).toContain("Base system prompt");
    expect(prompt).toContain("<paseo_voice_mode>");
    expect(prompt).toContain("Paseo voice mode is now on.");
    expect(prompt).toContain("Always use the speak tool for all user-facing communication.");
    expect(prompt).toContain("</paseo_voice_mode>");
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
});
