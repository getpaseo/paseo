import { expect, type Locator, type Page } from "@playwright/test";

/** The tones a composer toolbar control paints: its glyph's stroke and its label's text color. */
export interface ComposerControlTone {
  /** The visible glyph's stroke, or null when the control paints no glyph. */
  glyph: string | null;
  /** The visible label's color, or null when the control is icon-only. */
  label: string | null;
}

export function composerControl(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true }).first();
}

/**
 * Reads the colors the control actually paints. The toolbar glyph and its label are separate
 * nodes, so this is the only way to tell whether they match.
 */
export async function readComposerControlTone(control: Locator): Promise<ComposerControlTone> {
  return control.evaluate((element) => {
    const visible = (node: Element) => node.getClientRects().length > 0;
    const glyph = Array.from(element.querySelectorAll("svg")).find(visible);
    const label = Array.from(element.querySelectorAll("*"))
      .filter(visible)
      .find((node) =>
        [...node.childNodes].some(
          (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
        ),
      );
    return {
      glyph: glyph ? getComputedStyle(glyph).stroke : null,
      label: label ? getComputedStyle(label).color : null,
    };
  });
}

export function expectGlyphMatchesLabel(tone: ComposerControlTone, name: string): void {
  expect(tone.label, `${name} paints a label`).not.toBeNull();
  expect(tone.glyph, `${name}'s glyph matches its label`).toBe(tone.label);
}

export function expectIconOnlyGlyph(tone: ComposerControlTone, name: string): void {
  expect(tone.label, `${name} is icon-only`).toBeNull();
  expect(tone.glyph, `${name} paints a glyph`).not.toBeNull();
}

/** The color the browser paints in a text input's placeholder. */
export async function readComposerPlaceholderTone(input: Locator): Promise<string | null> {
  return input.evaluate((element) => getComputedStyle(element, "::placeholder").color);
}

/** The color the browser paints for a text node. */
export async function readComposerTextTone(text: Locator): Promise<string | null> {
  return text.evaluate((element) => getComputedStyle(element).color);
}
