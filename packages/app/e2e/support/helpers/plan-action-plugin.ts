import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pluginRequirements } from "./plugin-fixture";

/** A real plugin subprocess echoes the exact action context; its first review fails. */
export async function createPlanActionPlugin(options: { deferHandoff?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plan-actions-"));
  const handoffDirectory = JSON.stringify(directory);
  const deferHandoff = options.deferHandoff ?? false;
  await mkdir(path.join(directory, "shared"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "plan-actions-test", requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "shared/action.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const context = z.object({ action: z.string(), callId: z.string(), text: z.string(), permissionRequestId: z.string(), agentId: z.string(), workspaceId: z.string(), profileId: z.string().optional() });
export const actionRpc = defineRpc({ name: "plan.action", input: context, output: context });
`,
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { actionRpc } from "./shared/action";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const handoffDirectory = ${handoffDirectory};
export default function contribute(server) {
  let reviews = 0;
  server.handle(actionRpc, async (input) => {
    if (input.action === "review") {
      if (++reviews === 1) throw new Error("Review unavailable; retry");
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    if (input.action === "handoff") {
      if (${deferHandoff}) {
        writeFileSync(path.join(handoffDirectory, "handoff-started"), "started");
        while (!existsSync(path.join(handoffDirectory, "handoff-release")))
          await new Promise(resolve => setTimeout(resolve, 50));
      } else await new Promise(resolve => setTimeout(resolve, 1000));
      if (input.profileId === "unavailable") throw new Error("Handoff unavailable; retry another profile");
    }
    return input;
  });
  return () => {};
}
`,
  );
  await writeFile(
    path.join(directory, "index.client.ts"),
    `
import { actionRpc } from "./shared/action";
export default function contribute(client) {
  for (const [id, title, order] of [["review", "Revue", 10], ["handoff", "Handoff", 20]]) {
    client.addPlanAction({ id, title, order, requiresAgentProfile: id === "handoff", ...(id === "review" ? { async onAvailable() { throw new Error("Ignored availability failure"); } } : {}), async onPress({ rpc, plan, agent, workspace, navigation, profileId }) {
      const result = await rpc(actionRpc, { ...plan, action: id, agentId: agent.id, workspaceId: workspace.id, profileId });
      sessionStorage.setItem("plan-action-result", JSON.stringify(result));
      const executorId = sessionStorage.getItem("plan-action-executor");
      if (id === "handoff" && executorId) {
        (navigation.replaceAgent ?? navigation.openAgent)({ agentId: executorId });
        sessionStorage.setItem("plan-action-complete", "true");
      }
    } });
  }
  return () => {};
}
`,
  );
  return {
    directory,
    handoffStarted: () => existsSync(path.join(directory, "handoff-started")),
    releaseHandoff: () => writeFile(path.join(directory, "handoff-release"), "released"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
