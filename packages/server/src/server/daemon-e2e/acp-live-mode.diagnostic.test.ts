import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDaemonTestContext } from "../test-utils/index.js";

test("reports the provider's thinking level after an explicit live ACP mode change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-acp-live-mode-"));
  const options = {
    paseoHomeRoot: root,
    staticDir: path.join(root, "static"),
    cleanup: false,
    mcpEnabled: false,
    pluginsEnabled: false,
    providerOverrides: {
      "thinking-fixture": {
        extends: "acp" as const,
        label: "Thinking fixture",
        env: { ACP_TEST_LOAD_MODEL: "second-model", ACP_TEST_SAVED_MODE: "plan" },
        command: [
          process.execPath,
          path.join(import.meta.dirname, "acp-thinking-resume-fixture.cjs"),
        ],
      },
    },
  };
  try {
    const first = await createDaemonTestContext(options);
    let agentId: string;
    try {
      const agent = await first.client.createAgent({
        provider: "thinking-fixture",
        cwd: root,
        model: "second-model",
        modeId: "agent",
        thinkingOptionId: "low",
      });
      agentId = agent.id;
    } finally {
      await first.cleanup();
    }
    const reopened = await createDaemonTestContext(options);
    try {
      await reopened.client.fetchAgentTimeline(agentId, { limit: 40 });
      const before = (await reopened.client.fetchAgent(agentId))?.agent.runtimeInfo;
      expect(before).toMatchObject({ modeId: "agent", thinkingOptionId: "low" });
      await reopened.client.setAgentMode(agentId, "plan");
      const after = (await reopened.client.fetchAgent(agentId))?.agent.runtimeInfo;
      expect(after).toMatchObject({ modeId: "plan", thinkingOptionId: "high" });
    } finally {
      await reopened.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
