import type { Page } from "@playwright/test";

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

export interface TranscriptColors {
  heading: string | null;
  sidebar: string | null;
}

/** Computed colors of one transcript markdown heading and one chrome label. */
export function readTranscriptColors(page: Page): Promise<TranscriptColors> {
  return page.evaluate(() => {
    const findByText = (predicate: (text: string) => boolean) =>
      [...document.querySelectorAll("div,span,p")].find(
        (el) => el.childElementCount === 0 && predicate(el.textContent?.trim() ?? ""),
      );
    const headingEl = findByText((text) => text.startsWith("Cycle 1"));
    const sidebarEl = findByText((text) => text === "New workspace");
    return {
      heading: headingEl ? getComputedStyle(headingEl).color : null,
      sidebar: sidebarEl ? getComputedStyle(sidebarEl).color : null,
    };
  });
}
