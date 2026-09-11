import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  openProviderSubagentPane,
  stopSubagentControl,
} from "../support/helpers/provider-subagents";

/**
 * The stop control on a provider-subagent pane, through the app: capability gating, request
 * dispatch with duplicate-press suppression, and visible success and failure feedback. The mock
 * provider announces one running child and can be made slow, failing, or incapable, so every
 * state is deterministic — no real provider, no timing races.
 */

const MOCK_SUBAGENT_ID = "mock-subagent-1";
const STOP_FAILURE_COPY = "Could not stop this subagent";
const MOCK_INTERNAL_ERROR = "mock internal transport exploded";

function seedStopFlowParent(
  repoPrefix: string,
  featureValues: Record<string, unknown>,
): ReturnType<typeof seedMockAgentWorkspace> {
  return seedMockAgentWorkspace({
    repoPrefix,
    title: "Stop flow parent",
    model: "ten-second-stream",
    initialPrompt: "stream while a child runs",
    featureValues,
  });
}

test.describe("provider subagent stop control", () => {
  test.setTimeout(120_000);

  test("stops a running subagent from its pane, with pending and success feedback", async ({
    page,
  }) => {
    const agent = await seedStopFlowParent("provider-subagent-stop-", {
      mockProviderSubagent: "Sentry child",
      mockStopProviderSubagentDelayMs: 1500,
    });
    try {
      await openProviderSubagentPane(page, agent, {
        id: MOCK_SUBAGENT_ID,
        title: "Sentry child",
      });

      const stop = stopSubagentControl(page);
      // Pending: the control is suppressed for the duration of the request, so a second press
      // cannot dispatch a second stop.
      await stop.click();
      await expect(stop).toBeDisabled();

      // Success: the provider settles the child; a control for a non-running child is gone, and
      // no toast claims a failure that did not happen.
      await expect(stop).toBeHidden({ timeout: 30_000 });
      await expect(page.getByTestId("app-toast-message")).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });

  test("reports a failed stop with stable copy, not the provider's internal error", async ({
    page,
  }) => {
    const agent = await seedStopFlowParent("provider-subagent-stop-failure-", {
      mockProviderSubagent: "Unstoppable child",
      mockStopProviderSubagentError: MOCK_INTERNAL_ERROR,
    });
    try {
      await openProviderSubagentPane(page, agent, {
        id: MOCK_SUBAGENT_ID,
        title: "Unstoppable child",
      });

      const stop = stopSubagentControl(page);
      await stop.click();

      const toast = page.getByTestId("app-toast-message");
      await expect(toast).toBeVisible({ timeout: 30_000 });
      await expect(toast).toContainText(STOP_FAILURE_COPY);
      // The rejection reason is provider/transport diagnostics: it belongs in the log, not the
      // toast.
      await expect(toast).not.toContainText(MOCK_INTERNAL_ERROR);

      // The failure left the child running, so the control comes back and can be pressed again.
      await expect(stop).toBeVisible({ timeout: 30_000 });
    } finally {
      await agent.cleanup();
    }
  });

  test("renders no stop control for a provider that cannot stop one", async ({ page }) => {
    const agent = await seedStopFlowParent("provider-subagent-stop-incapable-", {
      mockProviderSubagent: "Incapable child",
      mockStopProviderSubagentUnsupported: true,
    });
    try {
      await openProviderSubagentPane(page, agent, {
        id: MOCK_SUBAGENT_ID,
        title: "Incapable child",
      });

      // The child is running and the daemon serves the RPC, but this provider never promised it
      // can stop one. A control here would render a button that cannot work.
      await expect(stopSubagentControl(page)).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
});
