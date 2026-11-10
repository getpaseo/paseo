import { test } from "../support/fixtures";
import {
  CHECKLIST,
  withComposerToolsExample,
  withPluginFocusingAComposer,
  withPluginFocusingASubagent,
  withPluginFocusingAnAgentWithContextUsage,
  withPluginHoldingNewWorkspaceComposer,
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

test("an Action in the compact controls sheet closes the sheet and focuses the composer", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withComposerToolsExample(page, async (author) => {
    await author.useCompactLayout();
    await author.insertChecklistFromControlsSheet();
    await author.expectComposerReadyToType(CHECKLIST);
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

test("a pill that inserts text and focuses leaves the cursor in the composer, ready to type", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withPluginFocusingAComposer(page, async (author) => {
    await author.openTargetAgent();
    await author.moveFocusOutOfComposer();
    await author.pressPill();
    await author.expectComposerFocused();
    await author.typeAtCursor(" world");
    await author.expectComposerText("HELLO world");
  });
});

test("focus reaches an agent in another tab of the workspace", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginFocusingAComposer(page, async (author) => {
    await author.openTargetAgent();
    await author.openOtherAgent();
    await author.focusFromCommandCenter();
    await author.expectOnTargetAgent();
    await author.expectComposerFocused();
  });
});

test("focus reaches an agent in another workspace, with the selection asked for", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withPluginFocusingAComposer(page, async (author) => {
    await author.openTargetAgent();
    await author.fillComposer("typed before");
    await author.goToAnotherWorkspace();
    await author.selectPromptFromCommandCenter();
    await author.expectOnTargetAgent();
    await author.expectComposerFocused();
    await author.typeAtCursor("replaced");
    await author.expectComposerText("replaced");
  });
});

test("focus closes the compact Explorer panel covering the composer", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginFocusingAComposer(page, async (author) => {
    await author.useCompactLayout();
    await author.openTargetAgent();
    await author.coverComposerWithExplorerPanel();
    await author.pressPanelFocusButton();
    await author.expectExplorerPanelClosed();
    await author.expectComposerFocused();
  });
});

test("focus rejects on a New workspace composer the user has left", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginHoldingNewWorkspaceComposer(page, async (author) => {
    await author.openNewWorkspace();
    await author.expectHeldComposerFocusResult("focused");
    await author.openSettings();
    await author.expectHeldComposerFocusResult("The composer is not on screen.");
  });
});

test("focus closes a picker the composer opened over itself", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginHoldingNewWorkspaceComposer(page, async (author) => {
    await author.openNewWorkspace();
    await author.openThinkingPicker();
    await author.expectHeldComposerFocusResult("focused");
    await author.expectHeldComposerReadyToType();
  });
});

test("focus closes an image preview the composer opened over itself", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginHoldingNewWorkspaceComposer(page, async (author) => {
    await author.openNewWorkspace();
    await author.previewAttachedImage();
    await author.expectHeldComposerFocusResult("focused");
    await author.expectHeldComposerReadyToType();
  });
});

test("overlapping focus calls end at the later selection while a preview closes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withPluginHoldingNewWorkspaceComposer(page, async (author) => {
    await author.openNewWorkspace();
    await author.typeInHeldComposer("HELLO");
    await author.previewAttachedImage();
    await author.expectOverlappingFocusesKeepTheLatestSelection();
  });
});

test("focus closes the context usage sheet on a phone", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginFocusingAnAgentWithContextUsage(page, async (author) => {
    await author.openContextUsageOnPhone();
    await author.focusAgent();
    await author.expectReadyToType();
  });
});

test("focus closes a page the composer's Subagents track opened over it", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginFocusingASubagent(page, async (author) => {
    await author.openParentAgent();
    await author.openSubagentPageInParentComposer();
    await author.focusParent();
    await author.expectParentReadyToType();
  });
});

test("focus reaches a New workspace composer opened from a compact Explorer", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginHoldingNewWorkspaceComposer(page, async (author) => {
    await author.leaveCompactExplorerForNewWorkspace();
    await author.expectHeldComposerFocusResult("focused");
  });
});

test("focus opens a compact subagent as a tab with its composer", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginFocusingASubagent(page, async (author) => {
    await author.openParentAgent();
    await author.openExplorer();
    await author.focusSubagent();
    await author.expectSubagentTabReadyToType();
  });
});

test("focus closes a file sheet still opening over an Explorer composer", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginFocusingASubagent(page, async (author) => {
    await author.keepParentInExplorerOnCompactScreen();
    await author.focusParent();
    await author.expectParentReadyToType();
    await author.focusParentAsAFileSheetOpens();
    await author.expectParentReadyToType();
  });
});

test("focus reaches an agent kept in the Explorer on a compact screen", async ({ page }) => {
  test.setTimeout(120_000);
  await withPluginFocusingASubagent(page, async (author) => {
    await author.keepParentInExplorerOnCompactScreen();
    await author.focusParent();
    await author.expectParentReadyToType();
    await author.coverExplorerComposerWithFileSheet();
    await author.focusParent();
    await author.expectParentReadyToType();
  });
});
