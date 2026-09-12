import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import {
  createAgentTabFromMenu,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { readTranscriptColors, THEME_SWITCH_COLORS } from "../support/helpers/markdown-theme";

/**
 * getpaseo/paseo#3581 regression: the OS switches appearance while the renderer never
 * delivers the matchMedia change events (a window suspended overnight). CSS-variable
 * styles repaint from the media query alone, but `withUnistyles` mappings — the agent
 * transcript markdown — keep the old theme's colors until focus reconciles the theme.
 */
test("markdown reconciles the system theme after suspended scheme change", async ({ page }) => {
  test.setTimeout(180_000);

  // Simulate the missed events: media queries still report `matches` live, but no
  // listener registration ever fires. This is what a suspended renderer looks like
  // to Unistyles' web runtime.
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => {
      const mql = original(query);
      // A plain facade so native accessors keep their receiver: `matches` reads the
      // live media state, but listener registration records nothing.
      return {
        media: mql.media,
        get matches() {
          return mql.matches;
        },
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      };
    };
  });

  await page.emulateMedia({ colorScheme: "dark" });

  const workspace = await seedWorkspace({ repoPrefix: "md-theme-suspended-" });

  try {
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await waitForWorkspaceTabsVisible(page);
    await createAgentTabFromMenu(page);
    await expectComposerVisible(page);

    const prompt = "Please review the scroll anchor behavior overnight.";
    await submitMessage(page, prompt);
    const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
    await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
    await expect(page.getByText("Cycle 1", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    const dark = await readTranscriptColors(page);
    expect(dark.heading).toBe(THEME_SWITCH_COLORS.dark.heading);
    expect(dark.sidebar).toBe(THEME_SWITCH_COLORS.dark.sidebar);

    // The OS switches to light overnight; the page never learns through events.
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(1_000);

    const stale = await readTranscriptColors(page);
    expect(stale.sidebar).toBe(THEME_SWITCH_COLORS.light.sidebar); // CSS variables repainted.
    expect(stale.heading).toBe(THEME_SWITCH_COLORS.dark.heading); // withUnistyles went stale.

    // The window regains focus the next morning.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect
      .poll(async () => (await readTranscriptColors(page)).heading, { timeout: 10_000 })
      .toBe(THEME_SWITCH_COLORS.light.heading);
  } finally {
    await workspace.cleanup();
  }
});
