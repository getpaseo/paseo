import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { createPlanActionPlugin } from "../support/helpers/plan-action-plugin";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

const profiles = [
  {
    id: "implementation",
    name: "Implementation",
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
  },
  {
    id: "review",
    name: "Deep review",
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
  },
  {
    id: "unavailable",
    name: "Unavailable profile",
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
  },
];

const handedOffPlan = `# Long handoff plan

## Keep the original Markdown

- Render **bold text** and \`inline code\`.
- Preserve escaped characters such as \\ and "quotes".
- Keep enough content to exercise the narrow layout without changing the source text.`;

const handedOffPrompt = `/paseo-handoff
PASEO_WORKFLOW_HANDOFF {"mode":"receiver","workflowId":"workflow-1","planId":"plan-1","role":"executor-bounded"}
Execute the approved plan here without creating another agent. Follow its scope and explicit authorizations; handoff grants no additional permissions. Preserve pre-existing and concurrent changes. Run targeted validation and report results and blockers.
${JSON.stringify({ plan: handedOffPlan, git: { startHead: "abc123" } }, null, 2)}`;

test("received handoff plans render as readable plans with opt-in technical details", async ({
  page,
  context,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "received-handoff-",
    title: "Handoff executor",
    initialPrompt: handedOffPrompt,
  });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openAgentRoute(page, session);

    const message = page.getByTestId("user-message").filter({ hasText: "Long handoff plan" });
    const card = message.getByTestId("handoff-plan-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Keep the original Markdown");
    await expect(card.getByText("bold text", { exact: true })).toBeVisible();
    await expect(message.getByText("PASEO_WORKFLOW_HANDOFF", { exact: false })).toHaveCount(0);
    await expect(message.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(message.getByRole("button", { name: "Hand off", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("handoff-plan-desktop.png") });

    await message.getByRole("button", { name: "Copy plan", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(handedOffPlan);
    await message.getByRole("button", { name: "Handoff details", exact: true }).click();
    await expect(message.getByText("PASEO_WORKFLOW_HANDOFF", { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("handoff-details-desktop.png") });
    await message.getByTestId("handoff-copy-message").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(handedOffPrompt);

    await page.reload();
    await expect(card).toBeVisible();
    await expect(message.getByText("PASEO_WORKFLOW_HANDOFF", { exact: false })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await card.screenshot({ path: testInfo.outputPath("handoff-plan-mobile.png") });
  } finally {
    await session.cleanup();
  }
});

test("handoff returns to the executor workspace after the source plan closes", async ({
  page,
}, testInfo) => {
  const plugin = await createPlanActionPlugin();
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "handoff-focus" });
  const previous = await client.getDaemonConfig();
  const session = await seedMockAgentWorkspace({
    repoPrefix: "handoff-focus-",
    title: "Source plan",
    initialPrompt: "Emit synthetic plan approval.",
  });
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true, agentProfiles: profiles });
    await client.installDirectoryPlugin(plugin.directory);
    await openAgentRoute(page, session);
    const executor = await session.client.createAgent({
      provider: "mock",
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      title: "Handoff executor",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    await page.evaluate((id) => sessionStorage.setItem("plan-action-executor", id), executor.id);
    await page.getByRole("button", { name: "Implementation", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("plan-action-result")))
      .not.toBeNull();
    const snapshot = await client.fetchAgent({ agentId: session.agentId });
    const permission = snapshot!.agent.pendingPermissions.find((entry) => entry.kind === "plan")!;
    await client.respondToPermissionAndWait(session.agentId, permission.id, {
      behavior: "deny",
      interrupt: true,
    });
    await expect(page.getByTestId("plan-handoff-profiles")).toHaveCount(0);
    await page
      .getByTestId("sidebar-global-new-workspace")
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/new(?:\?.*)?$/);
    await page.evaluate(() => sessionStorage.setItem("plan-action-release", "true"));
    await expect(page).toHaveURL(new RegExp(`/workspace/${session.workspaceId}(?:\\?.*)?$`));
    await expect(page.getByTestId(`workspace-tab-agent_${executor.id}`).first()).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId(`workspace-tab-agent_${session.agentId}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("handoff-focus.png") });
  } finally {
    await client.removePlugin("plan-actions-test");
    await client.patchDaemonConfig({
      pluginsEnabled: previous.config.pluginsEnabled ?? false,
      agentProfiles: previous.config.agentProfiles ?? [],
    });
    await client.close();
    await session.cleanup();
    await plugin.cleanup();
  }
});

test("plan actions keep exact context, isolate errors, lock remotely, and overflow on compact", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const plugin = await createPlanActionPlugin();
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "plan-actions" });
  const previous = await client.getDaemonConfig();
  const session = await seedMockAgentWorkspace({
    repoPrefix: "plan-actions-",
    title: "Interactive plan",
    initialPrompt: "Emit synthetic plan approval.",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true, agentProfiles: profiles });
    await client.installDirectoryPlugin(plugin.directory);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openAgentRoute(page, session);
    const card = page.getByTestId("timeline-plan-card");
    const bar = card.getByTestId("plan-actions");
    const review = bar.getByRole("button", { name: "Revue", exact: true });
    const profileRow = card.getByTestId("plan-handoff-profiles");
    const handoff = profileRow.getByRole("button", { name: "Implementation", exact: true });
    const approve = bar.getByRole("button", { name: "Approve", exact: true });
    await expect(bar.getByRole("button")).toHaveText([
      "Copy",
      "Revue",
      "Dismiss",
      "Approve",
      ...profiles.map((profile) => profile.name),
    ]);
    await expect(profileRow.getByRole("button")).toHaveText(
      profiles.map((profile) => profile.name),
    );
    await expect(profileRow.locator("[aria-selected=true]")).toHaveCount(0);
    const actionsBox = await approve.boundingBox();
    const profileBox = await profileRow.boundingBox();
    expect(profileBox!.y).toBeGreaterThan(actionsBox!.y);
    expect(await page.evaluate(() => sessionStorage.getItem("plan-action-available"))).toBeNull();
    await card.screenshot({ path: testInfo.outputPath("handoff-profiles-desktop.png") });
    await review.click();
    await expect(bar.getByRole("alert")).toContainText("Review unavailable; retry");
    const reviewError = await bar.getByRole("alert").innerText();
    const clipboardSupports = await page.evaluateHandle(() => ClipboardItem.supports);
    try {
      for (const [message, expected] of [
        ["Clipboard unavailable", `${reviewError} · Clipboard unavailable`],
        [reviewError, reviewError],
      ]) {
        // Fail at the browser clipboard boundary; keep the host action and state real.
        await page.evaluate((reason) => {
          ClipboardItem.supports = () => {
            throw new Error(reason);
          };
        }, message);
        await bar.getByRole("button", { name: "Copy", exact: true }).click();
        await expect(bar.getByRole("alert")).toHaveText(expected);
      }
    } finally {
      await page.evaluate((supports) => {
        ClipboardItem.supports = supports;
      }, clipboardSupports);
      await clipboardSupports.dispose();
    }
    await expect(approve).toBeEnabled();
    await review.click();
    await expect(review).toHaveAttribute("aria-busy", "true");
    await expect(handoff).toBeDisabled();
    await expect(approve).toBeDisabled();
    await bar.getByRole("button", { name: "Copy", exact: true }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('--name="my repo"');
    await expect(bar.getByRole("button", { name: "Copied", exact: true })).toBeEnabled();
    await expect(review).toBeEnabled({ timeout: 20_000 });
    const snapshot = await client.fetchAgent({ agentId: session.agentId });
    const permission = snapshot?.agent.pendingPermissions.find((entry) => entry.kind === "plan");
    expect(permission).toBeDefined();
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(sessionStorage.getItem("plan-action-result") ?? "null")),
      )
      .toEqual({
        action: "review",
        callId: permission!.sourcePlanCallId,
        permissionRequestId: permission!.id,
        text: clipboard,
        agentId: session.agentId,
        workspaceId: session.workspaceId,
      });
    await profileRow.getByRole("button", { name: "Unavailable profile", exact: true }).click();
    await expect(
      profileRow.getByRole("button", { name: "Unavailable profile", exact: true }),
    ).toHaveAttribute("aria-busy", "true");
    await expect(handoff).toBeDisabled();
    await expect(bar.getByRole("alert")).toContainText(
      "Handoff unavailable; retry another profile",
    );
    await expect(handoff).toBeEnabled();
    await handoff.click();
    await expect(handoff).toHaveAttribute("aria-busy", "true");
    await expect(
      profileRow.getByRole("button", { name: "Deep review", exact: true }),
    ).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(sessionStorage.getItem("plan-action-result") ?? "null")?.action,
        ),
      )
      .toBe("handoff");
    expect(
      await page.evaluate(
        () => JSON.parse(sessionStorage.getItem("plan-action-result") ?? "null").profileId,
      ),
    ).toBe("implementation");
    await page.reload();
    await expect(approve).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(approve).toBeVisible();
    await expect(review).toHaveCount(0);
    await bar.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Copy", "Revue"]);
    await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    await expect(approve).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect(profileRow.getByRole("button")).toHaveText(
      profiles.map((profile) => profile.name),
    );
    const firstProfileBox = await handoff.boundingBox();
    const lastProfileBox = await profileRow
      .getByRole("button", { name: "Unavailable profile", exact: true })
      .boundingBox();
    expect(lastProfileBox!.y).toBeGreaterThan(firstProfileBox!.y);
    await card.screenshot({ path: testInfo.outputPath("handoff-profiles-mobile.png") });
    await client.patchDaemonConfig({ agentProfiles: [] });
    await expect(profileRow).toContainText("No agent profiles available");
    await expect(profileRow.getByRole("button")).toHaveCount(0);
    await card.screenshot({ path: testInfo.outputPath("handoff-profiles-empty.png") });
    await approve.click();
    await expect(profileRow).toHaveCount(0);
    await expect(approve).toHaveCount(0);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('--name="my repo"');
    expect(errors).toEqual([]);
  } finally {
    await client.removePlugin("plan-actions-test");
    await client.patchDaemonConfig({
      pluginsEnabled: previous.config.pluginsEnabled ?? false,
      agentProfiles: previous.config.agentProfiles ?? [],
    });
    await client.close();
    await session.cleanup();
    await plugin.cleanup();
  }
});

test("cached plans stay read-only until the reconnected daemon restores a live permission snapshot", async ({
  page,
}) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "plan-actions-cache-",
    title: "Cached plan",
    initialPrompt: "Emit synthetic plan approval.",
  });
  try {
    await openAgentRoute(page, session);
    const card = page.getByTestId("timeline-plan-card");
    const bar = card.getByTestId("plan-actions");
    await expect(bar.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    let offline = true;
    let holdSnapshot = true;
    const releaseSnapshots: Array<() => void> = [];
    await page.routeWebSocket(daemonWsRoutePattern(), async (browser) => {
      if (offline) {
        await browser.close({ code: 1008, reason: "Isolated offline cache test" });
        return;
      }
      const server = browser.connectToServer();
      browser.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        const envelope = JSON.parse(message.toString());
        if (
          holdSnapshot &&
          ["fetch_agents_response", "fetch_agent_response"].includes(envelope.message?.type)
        ) {
          releaseSnapshots.push(browser.send.bind(browser, message));
        } else browser.send(message);
      });
    });
    await page.reload();
    await expect(card).toContainText('--name="my repo"');
    await expect(bar.getByRole("button")).toHaveText(["Copy"]);
    offline = false;
    await page.reload();
    await expect.poll(() => releaseSnapshots.length).toBeGreaterThan(0);
    await expect(bar.getByRole("button")).toHaveText(["Copy"]);
    holdSnapshot = false;
    for (const release of releaseSnapshots) release();
    await expect(bar.getByRole("button")).toHaveText(["Copy", "Dismiss", "Approve"]);
  } finally {
    await session.cleanup();
  }
});
