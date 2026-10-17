import { test, expect } from "../../app/e2e/support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../../app/e2e/support/helpers/mock-agent";
import { composerLocator, expectComposerVisible } from "../../app/e2e/support/helpers/composer";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime } from "./support/runtime";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await installDesktopRuntime(page, { serverId: getServerId() });
});

test("Enter sends and Shift+Enter inserts a newline in a narrow desktop window", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "compact-desktop-enter-",
    title: "Compact desktop keyboard",
  });
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    const composer = composerLocator(page);
    await composer.fill("A narrow desktop message");
    await composer.press("Shift+Enter");
    await expect(composer).toHaveValue("A narrow desktop message\n");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(
      page.getByTestId("user-message").filter({ hasText: "A narrow desktop message" }),
    ).toBeVisible();
    await composer.blur();
    await page.keyboard.press("Shift+?");
    await expect(page.getByTestId("keyboard-shortcuts-dialog")).toBeVisible();
    await page
      .getByTestId("keyboard-shortcuts-dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.getByTestId("keyboard-shortcuts-dialog")).not.toBeVisible();
    await page.keyboard.press("Meta+,");
    await expect.poll(() => new URL(page.url()).pathname).toContain("/settings");
    await page.keyboard.press("Escape");
    await expectComposerVisible(page);
  } finally {
    await agent.cleanup();
  }
});

test("mouse selection near the left edge does not open the desktop drawer", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "compact-desktop-selection-",
    title: "Compact desktop selection",
  });
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    const composer = composerLocator(page);
    await composer.fill("Select this text with a mouse in a narrow desktop window.");
    const box = await composer.boundingBox();
    if (!box) throw new Error("Composer has no bounds");
    const startX = box.x + 1;
    expect(startX).toBeLessThan(32);
    await page.mouse.move(startX, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(startX + 240, box.y + 12, { steps: 20 });
    await page.mouse.up();
    await expect
      .poll(() =>
        composer.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return input.selectionEnd - input.selectionStart;
        }),
      )
      .toBeGreaterThan(0);
    // Also cover a drag that begins in the margin outside the textarea. Inputs can
    // consume their own drags before the outer drawer handler sees them.
    await page.mouse.move(1, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(241, box.y + 12, { steps: 20 });
    await page.mouse.up();
    await expect(page.getByTestId("agent-list-backdrop")).toHaveCount(0);
    await page.getByTestId("menu-button").filter({ visible: true }).click();
    await expect(page.getByTestId("agent-list-backdrop")).toBeVisible();
    await page.getByTestId("sidebar-close").click();
    await expect(page.getByTestId("agent-list-backdrop")).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});
