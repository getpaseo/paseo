import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { createPlanActionPlugin } from "../support/helpers/plan-action-plugin";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

test("plan actions keep exact context, isolate errors, lock remotely, and overflow on compact", async ({
  page,
  context,
}) => {
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
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(plugin.directory);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openAgentRoute(page, session);
    const card = page.getByTestId("timeline-plan-card");
    const bar = card.getByTestId("plan-actions");
    const review = bar.getByRole("button", { name: "Revue", exact: true });
    const handoff = bar.getByRole("button", { name: "Hand off", exact: true });
    const approve = bar.getByRole("button", { name: "Approve", exact: true });
    await expect(bar.getByRole("button")).toHaveText(["Copy", "Revue", "Hand off", "Approve"]);
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
    const result = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("plan-action-result") ?? "null"),
    );
    expect(result).toEqual({
      action: "review",
      callId: permission!.sourcePlanCallId,
      permissionRequestId: permission!.id,
      text: clipboard,
      agentId: session.agentId,
      workspaceId: session.workspaceId,
    });
    await handoff.click();
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(sessionStorage.getItem("plan-action-result") ?? "null")?.action,
        ),
      )
      .toBe("handoff");
    await page.reload();
    await expect(approve).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(approve).toBeVisible();
    await expect(review).toHaveCount(0);
    await bar.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Copy", "Revue", "Hand off"]);
    await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    await expect(approve).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await approve.click();
    await expect(approve).toHaveCount(0);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('--name="my repo"');
    expect(errors).toEqual([]);
  } finally {
    await client.removePlugin("plan-actions-test");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
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
    await expect(bar.getByRole("button")).toHaveText(["Copy", "Approve"]);
  } finally {
    await session.cleanup();
  }
});
