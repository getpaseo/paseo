import { expect, test } from "../support/fixtures";
import {
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

test("handoff prompts render as expanded Markdown plan cards in history", async ({
  page,
}, info) => {
  const plan =
    "# Harmoniser les couleurs du popup externe\n\n- **Garder la hiérarchie** des titres.\n- Conserver `const palette = true`.\n\n```ts\nexport const palette = 'calm';\n```";
  const handoff = `/paseo-handoff\nPASEO_WORKFLOW_HANDOFF ${JSON.stringify({ mode: "receiver", workflowId: "workflow-e2e", planId: "plan-e2e", role: "executor-bounded" })}\nExecute the approved plan.\n${JSON.stringify({ plan, git: { branch: "private-git-data" } }, null, 2)}`;

  await withTimelinePlugin(page, info, "handoff", async (agent) => {
    await agent.client.sendAgentMessage(agent.agentId, handoff);
    await expect(page.getByTestId("handoff-plan-card")).toBeVisible();
    const executorTab = page.getByRole("button", {
      name: "Harmoniser les couleurs du popup externe",
    });
    await expect(executorTab).toBeVisible();
    await expect(page.getByRole("button", { name: "Plan transféré" })).toBeVisible();
    const planCard = page.getByTestId("handoff-plan-card");
    await expect(
      planCard.getByText("Harmoniser les couleurs du popup externe", { exact: true }),
    ).toBeVisible();
    const listMarkers = planCard.getByText("•", { exact: true });
    await expect(listMarkers).toHaveCount(2);
    const boldText = page.getByText("Garder la hiérarchie", { exact: true });
    await expect(boldText).toBeVisible();
    expect(
      Number.parseInt(
        await boldText.evaluate((element) => getComputedStyle(element).fontWeight),
        10,
      ),
    ).toBeGreaterThan(400);
    const codeBlock = page.getByText("export const palette = 'calm';", { exact: true });
    await expect(codeBlock).toBeVisible();
    const codeBackground = await codeBlock.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(codeBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(codeBackground).not.toBe("transparent");
    await expect(page.getByText(/PASEO_WORKFLOW_HANDOFF|private-git-data|"git"/)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("handoff-plan-card.png") });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("handoff-plan-card")).toBeVisible();
    await expect(executorTab).toBeVisible();
    await expect(page.getByRole("button", { name: "Plan transféré" })).toBeVisible();
    await expect(
      page.getByTestId("handoff-plan-card").getByText("Harmoniser les couleurs du popup externe", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/PASEO_WORKFLOW_HANDOFF|private-git-data|"git"/)).toHaveCount(0);
  });
});
