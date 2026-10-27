import { writeFile, rm, rename } from "node:fs/promises";
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

interface StartupGate {
  release(): Promise<void>;
  fail(): Promise<void>;
  dispose(): Promise<void>;
}

/** Holds every later workspace agent's startup until it is released or failed once. */
async function installStartupGate(): Promise<StartupGate> {
  const client = await connectNewWorkspaceDaemonClient();
  const plugin = await copyPluginExample("lifecycle-logger");
  const gate = path.join(plugin.directory, "startup.txt");
  const failure = path.join(plugin.directory, "startup-failure.txt");
  const previous = await client.getDaemonConfig();
  await writeFile(gate, "hold");
  await writeFile(failure, "fail");
  await writeFile(
    path.join(plugin.directory, "index.server.ts"),
    `
import { readFile, rm } from "node:fs/promises";
export default function contribute(server) {
  return server.before("agent.session_open", async ({ request }) => {
    // Metadata helpers have no workspace and must not consume the one-shot failure.
    if (request.reason !== "create" || !request.workspaceId) return request;
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
  return {
    release: () => rm(gate, { force: true }),
    // Replacing the command must not expose a truncated, empty file to the hook.
    fail: () => rename(failure, gate),
    async dispose() {
      await rm(gate, { force: true });
      await client.removePlugin("lifecycle-logger");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
      await plugin.cleanup();
      await client.close();
    },
  };
}

export const test = base.extend<{
  startup: StartupGate;
  /** A startup gate installed mid-test, after agents that must start normally. */
  lateStartup: { arm(): Promise<StartupGate> };
  promptRejection: void;
  /** Fails the next workspace request once it is armed. */
  provisioningFailure: { arm(): Promise<void> };
  creation: Awaited<ReturnType<typeof createCreationScenario>>;
  promptRetry: ReturnType<typeof createPromptRetryScenario>;
  workspacePromptRetry: ReturnType<typeof createPromptRetryScenario>;
  agentRetries: Awaited<ReturnType<typeof retryNextAgentCreation>>;
  delayedCreation: Awaited<ReturnType<typeof delayBrowserAgentCreatedStatus>>;
}>({
  startup: async ({ page }, provide) => {
    void page;
    const gate = await installStartupGate();
    try {
      await provide(gate);
    } finally {
      await gate.dispose();
    }
  },
  lateStartup: async ({ page }, provide) => {
    void page;
    const gates: StartupGate[] = [];
    try {
      await provide({
        arm: async () => {
          const gate = await installStartupGate();
          gates.push(gate);
          return gate;
        },
      });
    } finally {
      for (const gate of gates) await gate.dispose();
    }
  },
  provisioningFailure: async ({ page, creation }, provide) => {
    void page;
    void creation;
    const client = await connectNewWorkspaceDaemonClient();
    const plugin = await copyPluginExample("lifecycle-logger");
    const previous = await client.getDaemonConfig();
    try {
      const failure = path.join(plugin.directory, "provisioning-failure.txt");
      // Fails one workspace request per arm, so a resubmission can succeed.
      await writeFile(
        path.join(plugin.directory, "index.server.ts"),
        `
import { rm, stat } from "node:fs/promises";
export default function contribute(server) {
  return server.before("workspace.create", async ({ request }) => {
    const failure = ${JSON.stringify(failure)};
    if (!(await stat(failure).catch(() => null))) return request;
    await rm(failure, { force: true });
    throw new Error("Provisioning outcome is uncertain for test");
  });
}
`,
      );
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(plugin.directory);
      await provide({ arm: () => writeFile(failure, "fail") });
    } finally {
      await client.removePlugin("lifecycle-logger");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
      await plugin.cleanup();
      await client.close();
    }
  },
  promptRejection: async ({ page }, provide) => {
    void page;
    const client = await connectNewWorkspaceDaemonClient();
    const plugin = await copyPluginExample("lifecycle-logger");
    const previous = await client.getDaemonConfig();
    try {
      await writeFile(
        path.join(plugin.directory, "index.server.ts"),
        `
export default function contribute(server) {
  return server.before("agent.create", ({ request }) => ({
    ...request,
    config: {
      ...request.config,
      model: "e2e-fast-stream",
      featureValues: { ...request.config.featureValues, mockPromptRejections: 1 },
    },
  }));
}
`,
      );
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(plugin.directory);
      await provide();
    } finally {
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
  workspacePromptRetry: async ({ page }, provide) => {
    const gate = await installDaemonWebSocketGate(page);
    try {
      await provide(createPromptRetryScenario(page, gate, "workspace"));
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
