import { test, expect } from "../support/fixtures";
import {
  buildAgentRoute,
  openAgentRoute,
  seedMockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { getServerId } from "../support/helpers/server-id";
import {
  FOOTER_PLUGIN_ID,
  withTimelineFooterPlugin,
} from "../support/helpers/plugin-timeline-footer";

function scrollableHeight(node: HTMLElement): number {
  return node.scrollHeight - node.clientHeight;
}

function scrollTop(node: HTMLElement): number {
  return node.scrollTop;
}

for (const width of [1100, 390]) {
  test(`plugin footers pin outside real history and restore rows without gaps at width ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await withTimelineFooterPlugin(page, info, async (agent) => {
      const footer = page.getByTestId("plugin-timeline-footer");
      const history = page.getByTestId("agent-chat-scroll");
      const hiddenRows = history.locator(
        `[data-history-row-id$="${FOOTER_PLUGIN_ID}/missing"], [data-history-row-id$="${FOOTER_PLUGIN_ID}/invalid"], [data-history-row-id$="${FOOTER_PLUGIN_ID}/replaced"]`,
      );
      const expectPinned = async () => {
        await expect(
          footer.getByText(`Pinned on ${getServerId()} for ${agent.agentId}`, { exact: true }),
        ).toBeVisible();
        await expect(
          history.getByText("Plugin timeline item unavailable.", { exact: true }),
        ).toHaveCount(0);
        await expect(page.getByText("Inline pending card", { exact: true })).toHaveCount(0);
        await expect(hiddenRows).toHaveCount(0);
        await expect(
          history.getByText("Other version stays inline", { exact: true }),
        ).toBeVisible();
      };
      await expectPinned();
      await expect(history.getByTestId("plugin-timeline-footer")).toHaveCount(0);
      await expect.poll(() => history.evaluate(scrollableHeight)).toBeGreaterThan(500);
      const before = await footer.boundingBox();
      if (!before) throw new Error("Footer has no bounds");
      const initialScroll = await history.evaluate(scrollTop);
      await history.hover();
      await page.mouse.wheel(0, -600);
      await expect.poll(() => history.evaluate(scrollTop)).toBeLessThan(initialScroll - 100);
      await expect
        .poll(async () => {
          const after = await footer.boundingBox();
          return after ? Math.abs(after.y - before.y) : Infinity;
        })
        .toBeLessThan(1);
      await footer.getByRole("button", { name: "Footer clicks 0", exact: true }).click();
      await expect(
        footer.getByRole("button", { name: "Footer clicks 1", exact: true }),
      ).toBeVisible();
      await history.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expectPinned();
      await info.attach("pinned-layout", {
        body: await page.screenshot({ path: info.outputPath("pinned-layout.png") }),
        contentType: "image/png",
      });

      await footer.getByRole("button", { name: "Unpin cards", exact: true }).click();
      await expect(footer).toHaveCount(0);
      await expect(history.getByText("Inline pending card", { exact: true })).toBeVisible();
      await expect(
        history.getByText("Plugin timeline item unavailable.", { exact: true }),
      ).toHaveCount(2);
      await expect(hiddenRows).toHaveCount(3);
      await history.getByRole("button", { name: "Pin cards", exact: true }).last().click();
      await expectPinned();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectPinned();

      await footer.getByRole("button", { name: "Crash footer", exact: true }).click();
      await expect(
        footer.getByText("Plugin failed: footer regression failure", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
      const next = await agent.client.createAgent({
        provider: "mock",
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        title: "Footer recovery",
        model: "e2e-fast-stream",
        modeId: "load-test",
      });
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: next.id });
      await expect(
        footer.getByText(`Pinned on ${getServerId()} for ${next.id}`, { exact: true }),
      ).toBeVisible();
      await expect(
        footer.getByText("Plugin failed: footer regression failure", { exact: true }),
      ).toHaveCount(0);
    });
  });
}

test("a footer stays on its owning host when switching between real daemons", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await withTimelineFooterPlugin(page, info, async (primary) => {
    const secondaryDaemon = await startIsolatedHostDaemon("timeline-footer-secondary");
    const secondary = await seedMockAgentWorkspace({
      repoPrefix: "footer-secondary-",
      title: "Other host",
      port: secondaryDaemon.port,
    });
    try {
      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Other footer host",
        port: secondaryDaemon.port,
      });
      await expect(page.getByTestId("plugin-timeline-footer")).toBeVisible();
      await page.evaluate(() => {
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing fixture seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.goto(
        buildAgentRoute(secondary.workspaceId, secondary.agentId, secondaryDaemon.serverId),
      );
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
      await expect(page.getByTestId("plugin-timeline-footer")).toHaveCount(0);
      await openAgentRoute(page, primary);
      await expect(
        page
          .getByTestId("plugin-timeline-footer")
          .getByText(`Pinned on ${getServerId()} for ${primary.agentId}`, { exact: true }),
      ).toBeVisible();
    } finally {
      await secondary.cleanup();
      await secondaryDaemon.close();
    }
  });
});
