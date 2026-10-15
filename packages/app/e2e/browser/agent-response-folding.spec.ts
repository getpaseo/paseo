import path from "node:path";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("completed responses fold their steps and reopen in place on desktop and compact layouts", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "response-folding-",
    title: "Messages intermédiaires",
    model: "ten-second-stream",
    initialPrompt: "Corrige le bouton de connexion sur mobile.",
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);
    const toggle = page.getByTestId("response-fold-toggle");
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const label = await toggle.innerText();
    expect(label).toMatch(/^\d+ messages?$/);
    const final = page.getByTestId("assistant-message").last();
    await expect(final).toContainText("end of synthetic stream");
    const finalText = await final.innerText();
    const collapsedMessages = await page.getByTestId("assistant-message").count();
    await page.screenshot({ path: path.resolve("../../.context/response-fold-collapsed.png") });

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveText(label);
    await expect
      .poll(() => page.getByTestId("assistant-message").count())
      .toBeGreaterThan(collapsedMessages);
    await expect(final).toHaveText(finalText, { useInnerText: true });
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve("../../.context/response-fold-expanded.png") });

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("assistant-message")).toHaveCount(collapsedMessages);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(toggle).toBeVisible();
    await page.screenshot({
      path: path.resolve("../../.context/response-fold-mobile-collapsed.png"),
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => page.getByTestId("assistant-message").count())
      .toBeGreaterThan(collapsedMessages);
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.resolve("../../.context/response-fold-mobile-expanded.png"),
    });
  } finally {
    await agent.cleanup();
  }
});
