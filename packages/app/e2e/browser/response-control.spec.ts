import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

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
