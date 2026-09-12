import { expect, test } from "../support/fixtures";
import {
  openAgentTranscriptWithCycleHeading,
  regainWindowFocus,
  simulateSuspendedMediaChangeDelivery,
  THEME_SWITCH_COLORS,
  type AgentTranscriptSurface,
} from "../support/helpers/markdown-theme";

let transcript: AgentTranscriptSurface | null = null;

test.afterEach(async () => {
  await transcript?.cleanup();
  transcript = null;
});

/**
 * getpaseo/paseo#3581 regression: the OS switches appearance while the renderer
 * never delivers the matchMedia change events (a window suspended overnight).
 * CSS-variable styles repaint from the media query alone, but `withUnistyles`
 * mappings — the agent transcript markdown — keep the old theme's colors until
 * focus reconciles the theme.
 */
test("markdown reconciles the system theme after suspended scheme change", async ({ page }) => {
  test.setTimeout(180_000);

  await simulateSuspendedMediaChangeDelivery(page);
  await page.emulateMedia({ colorScheme: "dark" });
  transcript = await openAgentTranscriptWithCycleHeading(page, {
    repoPrefix: "md-theme-suspended-",
  });
  await expect(transcript.heading).toHaveCSS("color", THEME_SWITCH_COLORS.dark.heading);

  await page.emulateMedia({ colorScheme: "light" });

  await expect(transcript.sidebarLabel).toHaveCSS("color", THEME_SWITCH_COLORS.light.sidebar);
  await expect(transcript.heading).toHaveCSS("color", THEME_SWITCH_COLORS.dark.heading);
  await regainWindowFocus(page);
  await expect(transcript.heading).toHaveCSS("color", THEME_SWITCH_COLORS.light.heading);
});
