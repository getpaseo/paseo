import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  CODE_ACTIONS_SOURCE,
  CODE_ACTIONS_TEXT,
  CAPPED_CODE_ACTIONS_TEXT,
  withTimelinePlugin,
  requestPluginTimeline,
  interactWithStreamingCard,
  expectWholeCompletedCard,
  expectBothConsecutiveTools,
} from "../support/helpers/plugin-timeline";

for (const width of [1100, 390]) {
  test(`assistant plugin receives the whole streaming message at width ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await withTimelinePlugin(page, info, "assistant", async (agent) => {
      await requestPluginTimeline(agent);
      await interactWithStreamingCard(page);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectWholeCompletedCard(page);
      // Local state is checked during growth; the viewport remounts on the history handoff.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectWholeCompletedCard(page);
    });
  });
}

test("Overview preserves both consecutive tool plugin cards", async ({ page }, info) => {
  await withTimelinePlugin(page, info, "tools", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectBothConsecutiveTools(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectBothConsecutiveTools(page);
  });
});

for (const width of [1100, 390]) {
  test(`inline code actions retain fence identity through streaming and history at width ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await withTimelinePlugin(
      page,
      info,
      "assistant",
      async (agent) => {
        await requestPluginTimeline(agent);
        const first = page.getByRole("button", { name: "Run fence 1 clicks 0", exact: true });
        await expect(first).toBeVisible();
        await expect(first).toBeDisabled();
        await agent.client.waitForFinish(agent.agentId, 30_000);
        await expect(first).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "Run fence 2 clicks 0", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: "Run fence 0", exact: false })).toHaveCount(
          0,
        );
        await first.click();
        await expect(page.getByText("Executed echo first-fence", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Run fence 1 clicks 1", exact: true }),
        ).toBeVisible();
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(
          page.getByRole("button", { name: "Run fence 1 clicks 0", exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "Run fence 2 clicks 0", exact: true }),
        ).toBeEnabled();
        await expect(page.getByText("Executed echo first-fence", { exact: true })).toHaveCount(0);
      },
      { clientSource: CODE_ACTIONS_SOURCE, assistantText: CODE_ACTIONS_TEXT },
    );
  });
}

test("inline code actions stay disabled for a fence cut by the render cap", async ({
  page,
}, info) => {
  await withTimelinePlugin(
    page,
    info,
    "assistant",
    async (agent) => {
      await requestPluginTimeline(agent);
      await agent.client.waitForFinish(agent.agentId, 60_000);
      await expect(page.getByTestId("assistant-message-capped-notice")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Run fence 0 clicks 0", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Run fence 1 clicks 0", exact: true }),
      ).toBeDisabled();
    },
    {
      clientSource: CODE_ACTIONS_SOURCE,
      assistantText: CAPPED_CODE_ACTIONS_TEXT,
      instantResponse: true,
    },
  );
});
