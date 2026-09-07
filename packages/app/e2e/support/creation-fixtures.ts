import { test as base } from "./fixtures";
import {
  createCreationScenario,
  createPromptRetryScenario,
  retryNextAgentCreation,
} from "./helpers/creation";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";
import { delayBrowserAgentCreatedStatus } from "./helpers/new-workspace";

export const test = base.extend<{
  creation: Awaited<ReturnType<typeof createCreationScenario>>;
  promptRetry: ReturnType<typeof createPromptRetryScenario>;
  agentRetries: Awaited<ReturnType<typeof retryNextAgentCreation>>;
  delayedCreation: Awaited<ReturnType<typeof delayBrowserAgentCreatedStatus>>;
}>({
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
