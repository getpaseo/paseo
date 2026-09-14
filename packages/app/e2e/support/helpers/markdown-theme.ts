import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { seedWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { buildHostWorkspaceRoute } from "../../../src/utils/host-routes";
import { createAgentTabFromMenu, waitForWorkspaceTabsVisible } from "./workspace-tabs";
import { expectComposerVisible, submitMessage } from "./composer";

/**
 * Expected transcript/sidebar colors per system scheme, used by the theme-switch
 * e2e specs (getpaseo/paseo#3581). Hardcoded rgb is the established convention in
 * this suite (see appearance-theme-picker.spec.ts).
 */
export const THEME_SWITCH_COLORS = {
  dark: {
    /** Markdown heading color: dark theme foreground #fafafa. */
    heading: "rgb(250, 250, 250)",
    /** "New workspace" label color: dark theme foregroundMuted. */
    sidebar: "rgb(161, 165, 164)",
  },
  light: {
    /** Markdown heading color: light theme foreground #1a1a1e. */
    heading: "rgb(26, 26, 30)",
    /** "New workspace" label color: light theme foregroundMuted #71717a. */
    sidebar: "rgb(113, 113, 122)",
  },
} as const;

const CYCLE_HEADING_TEXT = "Cycle 1";
const SIDEBAR_LABEL_TEXT = "New workspace";
const DEFAULT_PROMPT = "Please review the scroll anchor behavior.";

export interface AgentTranscriptSurface {
  /** The transcript's first markdown heading ("Cycle 1"). */
  heading: Locator;
  /** A CSS-variable styled chrome label, as the repainting control surface. */
  sidebarLabel: Locator;
  cleanup(): Promise<void>;
}

/**
 * Seeds a workspace, opens a new agent tab, submits one turn, and waits for the
 * mock agent's "Cycle 1" markdown heading to render. The returned locators are
 * the surfaces the theme-switch specs assert computed colors on.
 */
export async function openAgentTranscriptWithCycleHeading(
  page: Page,
  input: { repoPrefix: string; prompt?: string },
): Promise<AgentTranscriptSurface> {
  const workspace = await seedWorkspace({ repoPrefix: input.repoPrefix });
  const prompt = input.prompt ?? DEFAULT_PROMPT;
  try {
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await waitForWorkspaceTabsVisible(page);
    await createAgentTabFromMenu(page);
    await expectComposerVisible(page);
    await submitMessage(page, prompt);
    const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
    await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
    const heading = page.getByText(CYCLE_HEADING_TEXT, { exact: true }).first();
    await expect(heading).toBeVisible({ timeout: 30_000 });
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
  return {
    heading: page.getByText(CYCLE_HEADING_TEXT, { exact: true }).first(),
    sidebarLabel: page.getByText(SIDEBAR_LABEL_TEXT, { exact: true }).first(),
    cleanup: () => workspace.cleanup(),
  };
}

/**
 * Simulates a renderer suspended across an OS appearance switch: media queries
 * keep reporting live `matches` state (so CSS repaints), but no `change` event is
 * ever delivered to registered listeners — which is exactly the state a window
 * wakes up in when the OS switched themes while it could not run tasks. Scoped to
 * the `prefers-color-scheme` queries; all other media queries pass through.
 */
export function simulateSuspendedMediaChangeDelivery(page: Page): Promise<void> {
  return page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => {
      const mql = original(query);
      if (!query.includes("prefers-color-scheme")) {
        return mql;
      }
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
}

/** The window regains focus, as it does when the user returns the next morning. */
export function regainWindowFocus(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });
}
