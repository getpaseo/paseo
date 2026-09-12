import { expect, test } from "../support/fixtures";
import {
  openAgentTranscriptWithCycleHeading,
  THEME_SWITCH_COLORS,
  type AgentTranscriptSurface,
} from "../support/helpers/markdown-theme";

let transcript: AgentTranscriptSurface | null = null;

test.afterEach(async () => {
  await transcript?.cleanup();
  transcript = null;
});

/**
 * getpaseo/paseo#3581 baseline: with System appearance, a live OS scheme switch
 * while the page is open must repaint the agent transcript markdown, not just
 * the CSS-variable chrome around it.
 */
test("markdown repaints after a live system theme switch", async ({ page }) => {
  test.setTimeout(180_000);

  await page.emulateMedia({ colorScheme: "dark" });
  transcript = await openAgentTranscriptWithCycleHeading(page, {
    repoPrefix: "md-theme-switch-",
  });
  await expect(transcript.heading).toHaveCSS("color", THEME_SWITCH_COLORS.dark.heading);

  await page.emulateMedia({ colorScheme: "light" });

  await expect(transcript.heading).toHaveCSS("color", THEME_SWITCH_COLORS.light.heading);
  await expect(transcript.sidebarLabel).toHaveCSS("color", THEME_SWITCH_COLORS.light.sidebar);
});
