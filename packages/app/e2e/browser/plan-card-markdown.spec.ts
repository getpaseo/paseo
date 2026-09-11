import { expect, test } from "../support/fixtures";
import { waitForPermissionPrompt } from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// The plan card has to pass its own markdown parser. Drop that prop and
// react-native-markdown-display silently supplies one with `typographer: true`
// (node_modules/react-native-markdown-display/src/index.js:139-141), which
// turns (c) into ©, curls straight quotes, and rewrites --- as an em dash.
// No unit test can catch that, because the defect lives in the JSX.
//
// Nothing here is provider-specific: the mock provider drives it, and the
// behavior is the same for every agent.
test("renders plan text verbatim, copies it, and hands it off", async ({ page }) => {
  test.setTimeout(180_000);

  const session = await seedMockAgentWorkspace({
    repoPrefix: "plan-card-markdown-",
    title: "Plan card markdown e2e",
    initialPrompt: "Emit synthetic plan approval.",
  });

  try {
    await openAgentRoute(page, session);
    await waitForPermissionPrompt(page, 120_000);

    const planCard = page.getByTestId("permission-plan-card");
    await expect(planCard).toContainText("(c)");
    await expect(planCard).toContainText('--name="my repo"');
    await expect(planCard).toContainText("---buzz");
    await expect(planCard).not.toContainText("©");
    await expect(planCard).not.toContainText("—buzz");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await planCard.getByTestId("plan-copy-content").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("(c)");
    await planCard.getByTestId("plan-copy-link").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(`/agent/${session.agentId}`);

    await planCard.getByTestId("permission-plan-handoff").click();
    await expect
      .poll(async () => {
        const agents = await session.client.fetchAgents({ scope: "active" });
        return agents.entries.filter(({ agent }) => agent.workspaceId === session.workspaceId)
          .length;
      })
      .toBe(2);
    const agents = await session.client.fetchAgents({ scope: "active" });
    const handedOff = agents.entries.find(
      ({ agent }) => agent.id !== session.agentId && agent.workspaceId === session.workspaceId,
    );
    expect(handedOff?.agent.model).toBe("e2e-fast-stream");
    await expect(
      page.getByText("Implement the attached proposed plan.", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("Proposed plan", { exact: true }).first()).toBeVisible();
  } finally {
    await session.cleanup();
  }
});
