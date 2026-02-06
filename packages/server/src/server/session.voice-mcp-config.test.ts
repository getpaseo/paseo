import { describe, expect, test } from "vitest";

import { buildVoiceAgentMcpServerConfig } from "./session.js";

describe("voice MCP stdio config", () => {
  test("builds stdio MCP config for voice agent", () => {
    const config = buildVoiceAgentMcpServerConfig({
      callerAgentId: "voice-agent-123",
      command: "/usr/local/bin/paseo",
      baseArgs: ["__paseo_voice_mcp_bridge", "--socket", "/tmp/paseo-voice.sock"],
      env: {
        PASEO_HOME: "/tmp/paseo-home",
      },
    });

    expect(config.type).toBe("stdio");
    expect(config.command).toBe("/usr/local/bin/paseo");
    expect(config.args).toEqual([
      "__paseo_voice_mcp_bridge",
      "--socket",
      "/tmp/paseo-voice.sock",
      "--caller-agent-id",
      "voice-agent-123",
    ]);
    expect(config.env).toEqual({
      PASEO_HOME: "/tmp/paseo-home",
    });
  });
});
