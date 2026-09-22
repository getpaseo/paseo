import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";

test("final metadata names desktop and compact tabs without entering the transcript", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "response-control-real-ui-" });
  try {
    const agent = await workspace.client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
    });
    await workspace.client.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, workspace.workspaceId));
    await workspace.client.sendAgentMessage(
      agent.id,
      "Reply with exactly the sentence: The display smoke test is complete. Follow the Paseo response metadata instructions. Do not use tools or access files.",
    );
    await workspace.client.waitForFinish(agent.id, 60_000);
    const result = await workspace.client.fetchAgents({ scope: "active" });
    const saved = result.entries.find((entry) => entry.agent.id === agent.id)?.agent;
    expect(saved?.responseMetadata?.lastTurn?.message).toBeTruthy();
    expect(saved?.title).toBeTruthy();
    expect(saved?.responseMetadata?.icon).toBeTruthy();
    const tab = page
      .getByTestId(`workspace-tab-agent_${agent.id}`)
      .filter({ visible: true })
      .first();
    await expect(tab).toContainText(saved!.title!);
    await expect(tab).toContainText(saved!.responseMetadata!.icon!);
    await expect(
      page.getByText("The display smoke test is complete.", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("<paseo-meta");
    await page.screenshot({ path: "/tmp/paseo-response-control-final.png" });
    await page.reload();
    await expect(tab).toContainText(saved!.title!);
    await expect(page.locator("body")).not.toContainText("<paseo-meta");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tab).toContainText(saved!.title!);
    await expect(tab).toContainText(saved!.responseMetadata!.icon!);
    await page.screenshot({ path: "/tmp/paseo-response-control-compact.png" });
  } finally {
    await workspace.cleanup();
  }
});
