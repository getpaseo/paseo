import { expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

const hostedEnvironments = [
  { transport: "Bedrock", env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
  { transport: "Vertex", env: { CLAUDE_CODE_USE_VERTEX: "true" } },
];

test.each(hostedEnvironments)(
  "offers Auto mode on $transport while preserving its default mode",
  async ({ env }) => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env },
      resolveVersion: async () => "2.1.263",
      discoverModels: async () => [],
    });

    const catalog = await client.fetchCatalog({ cwd: process.cwd() });

    expect(catalog.modes?.map((mode) => mode.id)).toContain("auto");
    expect(catalog.defaultModeId).toBe("default");
  },
);

test.each(hostedEnvironments)(
  "passes an explicit Auto selection on $transport to Claude Code",
  async ({ env }) => {
    const sdkError = new Error("Claude Code rejected this request");
    let requestedMode: string | undefined;
    let requestedEnv: NodeJS.ProcessEnv | undefined;
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env },
      resolveBinary: async () => "/test/claude",
      queryFactory: ({ options }) => {
        requestedMode = options.permissionMode;
        requestedEnv = options.env;
        throw sdkError;
      },
    });
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });

    try {
      await expect(session.setMode("auto")).rejects.toBe(sdkError);
      expect(requestedMode).toBe("auto");
      expect(requestedEnv).toMatchObject(env);
    } finally {
      await session.close();
    }
  },
);
