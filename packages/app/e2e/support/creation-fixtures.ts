import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { copyPluginExample } from "./helpers/plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "./helpers/new-workspace";
import { test as base } from "./fixtures";
import {
  createCreationScenario,
  createPromptRetryScenario,
  retryNextAgentCreation,
} from "./helpers/creation";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";
import { delayBrowserAgentCreatedStatus } from "./helpers/new-workspace";

export const test = base.extend<{
  startup: { release(): Promise<void>; fail(): Promise<void> };
  creation: Awaited<ReturnType<typeof createCreationScenario>>;
  promptRetry: ReturnType<typeof createPromptRetryScenario>;
  agentRetries: Awaited<ReturnType<typeof retryNextAgentCreation>>;
  delayedCreation: Awaited<ReturnType<typeof delayBrowserAgentCreatedStatus>>;
}>({
  startup: async ({ page }, provide) => {
    void page;
    const client = await connectNewWorkspaceDaemonClient();
    const plugin = await copyPluginExample("lifecycle-logger");
    const gate = path.join(plugin.directory, "startup.txt");
    const previous = await client.getDaemonConfig();
    try {
      await writeFile(gate, "hold");
      await writeFile(
        path.join(plugin.directory, "index.server.ts"),
        `
import { readFile, rm } from "node:fs/promises";
export default function contribute(server) {
  return server.before("agent.session_open", async ({ request }) => {
    if (request.reason !== "create") return request;
    const gate = ${JSON.stringify(gate)};
    let command = await readFile(gate, "utf8").catch(() => "release");
    while (command === "hold") {
      await new Promise(resolve => setTimeout(resolve, 20));
      command = await readFile(gate, "utf8").catch(() => "release");
    }
    if (command === "fail") {
      await rm(gate, { force: true });
      throw new Error("Creation startup failed for test");
    }
    return request;
  });
}
`,
      );
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(plugin.directory);
      await provide({
        release: () => rm(gate, { force: true }),
        fail: () => writeFile(gate, "fail"),
      });
    } finally {
      await rm(gate, { force: true });
      await client.removePlugin("lifecycle-logger");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
      await plugin.cleanup();
      await client.close();
    }
  },
  creation: async ({ page }, provide) => {
    const creation = await createCreationScenario(page);
    try {
      await provide(creation);
    } finally {
      await creation.cleanup();
    }
  },
  promptRetry: async ({ page }, provide) => {
    const gate = await installDaemonWebSocketGate(page);
    try {
      await provide(createPromptRetryScenario(page, gate));
    } finally {
      gate.restore();
    }
  },
  agentRetries: async ({ page }, provide) => {
    await provide(await retryNextAgentCreation(page));
  },
  delayedCreation: async ({ page }, provide) => {
    const delayed = await delayBrowserAgentCreatedStatus(page);
    try {
      await provide(delayed);
    } finally {
      delayed.release();
    }
  },
});
