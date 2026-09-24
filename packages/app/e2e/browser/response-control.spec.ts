import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import { composerLocator, expectComposerDraft } from "../support/helpers/composer";

interface Envelope {
  type?: string;
  message?: { type?: string; requestId?: string; agentId?: string; namingMode?: string };
}

test("automatic naming shows a failed update and retries successfully", async ({ page }) => {
  test.setTimeout(120_000);
  let failNext = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      const envelope: Envelope = JSON.parse(raw);
      const request = envelope.message;
      if (
        failNext &&
        request?.type === "update_agent_request" &&
        request.namingMode === "automatic"
      ) {
        failNext = false;
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "update_agent_response",
              payload: {
                requestId: request.requestId,
                agentId: request.agentId,
                accepted: false,
                error: "Naming update failed. Try again.",
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
  });
  const workspace = await seedWorkspace({ repoPrefix: "response-control-ui-" });
  try {
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Manual name",
    });
    await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
    await waitForWorkspaceTabsVisible(page);
    const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
    await expect(tab).toContainText("Manual name");
    await tab.click({ button: "right" });
    await page.getByTestId(`workspace-tab-context-agent_${agent.id}-automatic-naming`).click();
    await expect(page.getByText("Naming update failed. Try again.")).toBeVisible();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("automatic-naming-status")).not.toBeVisible();
    await expect
      .poll(async () => {
        const result = await workspace.client.fetchAgents({ scope: "active" });
        return result.entries.find((entry) => entry.agent.id === agent.id)?.agent.responseMetadata
          ?.namingMode;
      })
      .toBe("automatic");
    await expect(tab).toContainText("Manual name");
    await page.screenshot({ path: "/tmp/paseo-response-control-tab.png" });
  } finally {
    await workspace.cleanup();
  }
});

test("host response control is enabled by default and can be switched off", async ({ page }) => {
  await page.goto(`/settings/hosts/${encodeURIComponent(getServerId())}/agents`);
  const toggle = page.getByTestId("host-page-response-control-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: "/tmp/paseo-response-control-settings.png" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

const RECOMMENDED_PROMPTS_RESPONSE = [
  "Renamed the tabs.",
  '<paseo-meta message="Renamed the tabs." prompt1="Run the tests" prompt2="Open a pull request" />',
].join("\n");

test("recommended prompts send directly or prefill the composer", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "recommended-prompts-",
    title: "Recommended prompts",
    featureValues: { mockAssistantResponse: RECOMMENDED_PROMPTS_RESPONSE },
  });
  try {
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Rename the tabs.");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await awaitAssistantMessage(page, "Renamed the tabs.");
    await expect(page.getByTestId("assistant-message").last()).not.toContainText("paseo-meta");

    const prompts = page.getByTestId("recommended-prompts").last();
    await expect(prompts).toBeVisible();
    await expect(prompts.getByTestId("recommended-prompt-send")).toHaveText([
      "Run the tests",
      "Open a pull request",
    ]);

    const first = prompts.getByTestId("recommended-prompt").first();
    await first.hover();
    await first.getByTestId("recommended-prompt-use-edited").click();
    await expectComposerDraft(page, "Run the tests");
    await expect(composerLocator(page)).toBeFocused();
    await page.screenshot({ path: "/tmp/paseo-recommended-prompts.png" });

    await prompts.getByTestId("recommended-prompt-send").nth(1).click();
    await expect(
      page.getByTestId("user-message").filter({ hasText: "Open a pull request" }),
    ).toBeVisible();
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectComposerDraft(page, "Run the tests");
  } finally {
    await agent.cleanup();
  }
});
