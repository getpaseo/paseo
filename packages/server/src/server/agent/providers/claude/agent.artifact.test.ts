import { expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

test.each(["new", "resumed"] as const)(
  "%s Claude sessions enable Artifact by default and preserve explicit overrides",
  async (sessionKind) => {
    const client = new ClaudeAgentClient({ logger: createTestLogger() });
    const config = { provider: "claude", cwd: process.cwd() };
    const session =
      sessionKind === "new"
        ? await client.createSession(config)
        : await client.resumeSession(
            {
              provider: "claude",
              sessionId: "artifact-env-session",
              metadata: { cwd: config.cwd },
            },
            config,
          );

    try {
      expect(session.usageSession?.()?.env.CLAUDE_CODE_ARTIFACT).toBe(
        process.env.CLAUDE_CODE_ARTIFACT ?? "1",
      );
    } finally {
      await session.close();
    }
  },
);

test.each([
  { providerValue: "0", launchValue: undefined, expected: "0" },
  { providerValue: "1", launchValue: undefined, expected: "1" },
  { providerValue: "", launchValue: undefined, expected: "" },
  { providerValue: undefined, launchValue: "0", expected: "0" },
  { providerValue: "1", launchValue: "0", expected: "0" },
  { providerValue: "0", launchValue: "1", expected: "1" },
])(
  "preserves provider=$providerValue / launch=$launchValue in new and resumed sessions",
  async ({ providerValue, launchValue, expected }) => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        env: {
          PASEO_TEST_FLAG: "provider-value",
          ...(providerValue === undefined ? {} : { CLAUDE_CODE_ARTIFACT: providerValue }),
        },
      },
    });
    const config = { provider: "claude", cwd: process.cwd() };
    const launchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000203",
        ...(launchValue === undefined ? {} : { CLAUDE_CODE_ARTIFACT: launchValue }),
      },
    };
    const sessions = [
      await client.createSession(config, launchContext),
      await client.resumeSession(
        { provider: "claude", sessionId: "artifact-env-session", metadata: { cwd: config.cwd } },
        config,
        launchContext,
      ),
    ];

    try {
      for (const session of sessions) {
        const env = session.usageSession?.()?.env;
        expect(env?.CLAUDE_CODE_ARTIFACT).toBe(expected);
        expect(env?.PASEO_TEST_FLAG).toBe("provider-value");
        expect(env?.PASEO_AGENT_ID).toBe(launchContext.env.PASEO_AGENT_ID);
      }
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
  },
);
