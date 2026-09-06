import { expect, test, type Page } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectWorkspaceTabVisible } from "../support/helpers/archive-tab";

// The `/exit` client command is always present in an open (non-draft) agent and
// carries a stable description, so it is the deterministic target for the hover
// tooltip. The row renders the description with numberOfLines={1}; the tooltip
// surfaces the same text in full on hover.
const EXIT_COMMAND_ID = "exit";
const EXIT_DESCRIPTION = "Archive the current agent";

async function openReadyMockAgent(page: Page) {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "composer-command-tooltip-",
    title: "Command tooltip e2e",
    initialPrompt: "Prepare a command tooltip test agent.",
  });
  await openAgentRoute(page, session);
  await expectWorkspaceTabVisible(page, session.agentId);
  await expectComposerVisible(page);
  return session;
}

test.describe("Composer command autocomplete tooltip", () => {
  test("hovering a command row reveals the full description and dismisses on leave", async ({
    page,
  }) => {
    const session = await openReadyMockAgent(page);
    try {
      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });
      await input.fill("/ex");

      const row = page.getByTestId(`composer-autocomplete-option-${EXIT_COMMAND_ID}`);
      await expect(row).toBeVisible({ timeout: 30_000 });

      const tooltip = page.getByTestId(`composer-autocomplete-tooltip-${EXIT_COMMAND_ID}`);
      // No tooltip until the row is hovered.
      await expect(tooltip).toHaveCount(0);

      await row.hover();

      await expect(tooltip).toBeVisible({ timeout: 10_000 });
      await expect(tooltip).toContainText(EXIT_DESCRIPTION);

      // Leaving the row dismisses the tooltip.
      await page.mouse.move(0, 0);
      await expect(tooltip).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });
});
