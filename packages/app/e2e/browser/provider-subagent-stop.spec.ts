import { test, expect } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { openSubagentsTrack } from "../support/helpers/subagents";

/**
 * The stop control on a provider-subagent pane, through the app: capability gating, request
 * dispatch with duplicate-press suppression, and visible success and failure feedback. The mock
 * provider announces one running child and can be made slow, failing, or incapable, so every
 * state is deterministic — no real provider, no timing races.
 */

const STOP_BUTTON = "provider-subagent-pane-stop";
const STOP_FAILURE_COPY = "Could not stop this subagent";
const MOCK_INTERNAL_ERROR = "mock internal transport exploded";

async function openSubagentPane(
  page: Parameters<typeof openAgentRoute>[0],
  agent: MockAgentWorkspace,
  expectedTitle: string,
): Promise<void> {
  await openAgentRoute(page, {
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
  });
  await openSubagentsTrack(page);
  const row = page.getByTestId("subagents-track-row-mock-subagent-1");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(expectedTitle);
  await row.click();
  await expect(page.getByTestId("provider-subagent-panel")).toBeVisible({ timeout: 30_000 });
}

test.describe("provider subagent stop control", () => {
  test.setTimeout(120_000);

  test("stops a running subagent from its pane, with pending and success feedback", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "provider-subagent-stop-",
      title: "Stop flow parent",
      model: "ten-second-stream",
      initialPrompt: "stream while a child runs",
      featureValues: {
        mockProviderSubagent: "Sentry child",
        mockStopProviderSubagentDelayMs: 1500,
      },
    });
    try {
      await openSubagentPane(page, agent, "Sentry child");

      const stop = page.getByTestId(STOP_BUTTON);
      await expect(stop).toBeVisible();

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
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "provider-subagent-stop-failure-",
      title: "Stop failure parent",
      model: "ten-second-stream",
      initialPrompt: "stream while a child runs",
      featureValues: {
        mockProviderSubagent: "Unstoppable child",
        mockStopProviderSubagentError: MOCK_INTERNAL_ERROR,
      },
    });
    try {
      await openSubagentPane(page, agent, "Unstoppable child");

      const stop = page.getByTestId(STOP_BUTTON);
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
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "provider-subagent-stop-incapable-",
      title: "Incapable parent",
      model: "ten-second-stream",
      initialPrompt: "stream while a child runs",
      featureValues: {
        mockProviderSubagent: "Incapable child",
        mockStopProviderSubagentUnsupported: true,
      },
    });
    try {
      await openSubagentPane(page, agent, "Incapable child");

      // The child is running and the daemon serves the RPC, but this provider never promised it
      // can stop one. A control here would render a button that cannot work.
      await expect(page.getByTestId(STOP_BUTTON)).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
});
