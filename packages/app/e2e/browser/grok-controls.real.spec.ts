import { test as base } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  type GrokControlsContext,
  createGrokAgent,
  verifyGrokEffortSelection,
  approveGrokWrite,
  allowGrokWrite,
} from "../support/helpers/grok-controls";

const test = base.extend<{ controls: GrokControlsContext }>({
  controls: async ({ page }, provide, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "grok-controls-" });
    const agentIds: string[] = [];
    try {
      const agent = await createGrokAgent(workspace, "grok-4.6");
      agentIds.push(agent.id);
      const isolatedAgent = await createGrokAgent(workspace, "grok-4.5");
      agentIds.push(isolatedAgent.id);
      await provide({
        page,
        workspace,
        testInfo,
        agentId: agent.id,
        isolatedAgentId: isolatedAgent.id,
      });
    } finally {
      for (const agentId of agentIds) await workspace.client.archiveAgent(agentId);
      await workspace.cleanup();
    }
  },
});

test.describe.configure({ timeout: 360_000 });

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        grok: {
          extends: "acp",
          label: "Grok",
          command: ["grok", "--no-auto-update", "agent", "stdio"],
          enabled: true,
          // A stale configured choice exercises a real daemon rejection from the picker.
          additionalModels: [
            {
              id: "grok-4.6",
              label: "Grok 4.6",
              thinkingOptions: [
                { id: "xhigh", label: "Extra high" },
                { id: "high", label: "High", isDefault: true },
                { id: "medium", label: "Medium" },
                { id: "low", label: "Low" },
                { id: "unsupported", label: "Unavailable" },
              ],
            },
          ],
        },
      },
    },
  },
});

test("Grok composer controls apply effort and native tool permissions", async ({ controls }) => {
  await verifyGrokEffortSelection(controls);
  await approveGrokWrite(controls, "ask");
  await allowGrokWrite(controls, "Always approve");
  await approveGrokWrite({ ...controls, agentId: controls.isolatedAgentId }, "isolated");
  await allowGrokWrite(controls, "Auto");
});
