import { test } from "../support/fixtures";
import {
  CHECKLIST,
  withComposerToolsExample,
  withPluginWritingToAnotherWorkspace,
} from "../support/helpers/plugin-composers-by-reference";

test("a panel in the Explorer inserts at the cursor of the focused agent's composer", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withComposerToolsExample(page, async (author) => {
    await author.openComposerToolsInExplorer();
    await author.typeInComposer("start end", 5);
    await author.insertChecklistFromPanel();
    await author.expectComposerText(`start${CHECKLIST} end`);
  });
});

test("a Command Center item changes an agent's metadata through its composer", async ({ page }) => {
  test.setTimeout(120_000);
  await withComposerToolsExample(page, async (author) => {
    await author.openComposerToolsInExplorer();
    await author.expectPanelShowsReview(false);
    await author.markForReviewFromCommandCenter();
    await author.expectPanelShowsReview(true);
  });
});

test("the panel follows which agent is focused", async ({ page }) => {
  test.setTimeout(120_000);
  await withComposerToolsExample(page, async (author) => {
    await author.openComposerToolsInExplorer();
    await author.expectPanelFocusedAgent(true);
    await author.focusANewAgentTab();
    await author.expectPanelFocusedAgent(false);
    await author.focusTheAgentTab();
    await author.expectPanelFocusedAgent(true);
  });
});

test("a plugin writes to an agent's composer while its workspace is not on screen", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withPluginWritingToAnotherWorkspace(page, async (author) => {
    await author.openTargetAgent();
    await author.goToAnotherWorkspace();
    await author.insertFromCommandCenter();
    await author.returnToTargetWorkspace();
    await author.expectComposerText("A note from a plugin");
  });
});
