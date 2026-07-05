import { describe, expect, test } from "vitest";

import {
  buildDedicatedVoiceAgentMcpServerConfig,
  buildVoiceAgentMcpServerConfig,
  buildVoiceModeSystemPrompt,
  PASEO_VOICE_MCP_SERVER_NAME,
  resolveVoiceAgentBridgeSocketPath,
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
    expect(config.enabledTools).toEqual(["speak"]);
    expect(config.defaultToolsApprovalMode).toBe("prompt");
    expect(config.tools).toEqual({
      speak: { approvalMode: "approve" },
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

  test("builds enabled voice instructions for a dedicated voice MCP server", () => {
    const prompt = buildVoiceModeSystemPrompt("Base system prompt", true, {
      voiceToolMcpServerName: PASEO_VOICE_MCP_SERVER_NAME,
    });

    expect(prompt).toContain(`Always use the ${PASEO_VOICE_MCP_SERVER_NAME}.speak tool`);
    expect(prompt).toContain(`first call ${PASEO_VOICE_MCP_SERVER_NAME}.speak`);
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

  test("mentions the dedicated voice MCP tool when configured", () => {
    expect(
      wrapSpokenInput("hello", {
        voiceToolMcpServerName: PASEO_VOICE_MCP_SERVER_NAME,
      }),
    ).toContain(`Respond using the ${PASEO_VOICE_MCP_SERVER_NAME}.speak tool only`);
  });
});

describe("voice bridge resolution", () => {
  test("resolves local socket and pipe listeners", () => {
    expect(resolveVoiceAgentBridgeSocketPath("unix:///tmp/paseo.sock")).toBe("/tmp/paseo.sock");
    expect(resolveVoiceAgentBridgeSocketPath("/tmp/paseo.sock")).toBe("/tmp/paseo.sock");
    expect(resolveVoiceAgentBridgeSocketPath("pipe://voice-bridge")).toBe("voice-bridge");
    expect(resolveVoiceAgentBridgeSocketPath("127.0.0.1:1234")).toBeNull();
  });

  test("builds a dedicated voice MCP bridge config for local listeners", () => {
    const config = buildDedicatedVoiceAgentMcpServerConfig({
      listen: "/tmp/paseo.sock",
      paseoHome: "/tmp/paseo-home",
    });

    expect(config).not.toBeNull();
    expect(config?.type).toBe("stdio");
    expect(config?.args.at(-2)).toBe("--socket");
    expect(config?.args.at(-1)).toBe("/tmp/paseo.sock");
    expect(config?.env?.PASEO_HOME).toBe("/tmp/paseo-home");
  });

  test("builds a dedicated HTTP voice MCP config when an agent MCP base URL is available", () => {
    const config = buildDedicatedVoiceAgentMcpServerConfig({
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      callerAgentId: "00000000-0000-4000-8000-000000000001",
      mcpAuthToken: "test-token",
      listen: "127.0.0.1:6767",
      paseoHome: "/tmp/paseo-home",
    });

    expect(config).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=00000000-0000-4000-8000-000000000001&voiceOnly=1",
      enabledTools: ["speak"],
      defaultToolsApprovalMode: "prompt",
      tools: {
        speak: { approvalMode: "approve" },
      },
      headers: {
        Authorization: "Bearer test-token",
      },
    });
  });
});
