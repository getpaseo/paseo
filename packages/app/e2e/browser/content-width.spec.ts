import { test } from "../support/fixtures";
import {
  expectContentColumnWidth,
  expectCustomContentWidthSetting,
  expectDefaultContentWidthSetting,
  openAppearanceSettings,
  resetContentWidth,
  setContentWidth,
} from "../support/helpers/content-width";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const ULTRAWIDE_VIEWPORT = { width: 2560, height: 1080 };

test("widens chat and Markdown files to the chosen content width and resets to the default", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "content-width-",
    title: "Content width",
    initialPrompt: "Write a long paragraph.",
  });

  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await page.setViewportSize(ULTRAWIDE_VIEWPORT);
    const assistantMessage = page.getByTestId("assistant-message").first();
    const markdownPreview = page.getByTestId("markdown-preview-frame").first();

    await test.step("chat starts at the default width", async () => {
      await openAgentRoute(page, agent);
      await expectContentColumnWidth(assistantMessage, { max: 820 });
    });

    await test.step("settings show the default without a reset", async () => {
      await openAppearanceSettings(page);
      await expectDefaultContentWidthSetting(page, 820);
    });

    await test.step("a custom width is saved and offers a reset", async () => {
      await setContentWidth(page, 1600);
      await expectCustomContentWidthSetting(page, 1600);
      await page.screenshot({ path: testInfo.outputPath("settings-custom-width.png") });
    });

    await test.step("chat and Markdown files use the custom width", async () => {
      await openAgentRoute(page, agent);
      await expectContentColumnWidth(assistantMessage, { min: 1200, max: 1600 });
      await page.screenshot({ path: testInfo.outputPath("chat-custom-width.png") });

      await openFileExplorer(page);
      await openFileFromExplorer(page, "README.md");
      await expectContentColumnWidth(markdownPreview, { min: 1200, max: 1600 });
      await page.screenshot({ path: testInfo.outputPath("markdown-custom-width.png") });
    });

    await test.step("reset returns to the default without storing it", async () => {
      await openAppearanceSettings(page);
      await resetContentWidth(page);
      await expectDefaultContentWidthSetting(page, 820);

      await openAgentRoute(page, agent);
      await expectContentColumnWidth(assistantMessage, { max: 820 });
      await page.screenshot({ path: testInfo.outputPath("chat-default-width.png") });
    });
  } finally {
    await agent.cleanup();
  }
});
