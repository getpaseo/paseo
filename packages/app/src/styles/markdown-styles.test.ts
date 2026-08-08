import { describe, expect, it } from "vitest";
import { createCompactMarkdownStyles, createMarkdownStyles } from "./markdown-styles";
import { darkTheme, type Theme } from "./theme";

// Stated here as a literal on purpose. Importing the implementation's own constant
// would make these assertions circular: lowering it would keep the tests green while
// reintroducing the clipping they exist to catch. ~1.45em is Noto Sans CJK's
// ascent + descent, so this is the behaviour the styles owe callers, not a knob.
const REQUIRED_MIN_RATIO = 1.45;

const HEADING_KEYS = [
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
] as const;

// Mirrors what `applyAppearance` does when the user raises the UI font size:
// the whole ramp scales, so anything that hardcodes a companion line height
// silently tightens until glyphs collide. `code` is left alone to match
// `scaleFontSize`, which sets it absolutely from the separate code-size control.
function withScaledFontRamp(theme: Theme, ratio: number): Theme {
  const fontSize = Object.fromEntries(
    Object.entries(theme.fontSize).map(([key, size]) => [
      key,
      key === "code" ? size : Math.round(size * ratio),
    ]),
  ) as Theme["fontSize"];
  return { ...theme, fontSize };
}

describe("createMarkdownStyles", () => {
  it("applies shrink-and-wrap constraints to long markdown text and links", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.body).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      width: "100%",
    });

    expect(styles.paragraph).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      width: "100%",
      flexWrap: "wrap",
    });

    expect(styles.text).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });

    expect(styles.link).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });

    expect(styles.blocklink).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });
  });

  it("keeps assistant markdown text selectable on web", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.body).toMatchObject({
      userSelect: "text",
    });
    expect(styles.text).toMatchObject({
      userSelect: "text",
    });
    expect(styles.heading1).toMatchObject({
      userSelect: "text",
    });
    expect(styles.link).toMatchObject({
      userSelect: "text",
    });
    expect(styles.code_inline).toMatchObject({
      userSelect: "text",
    });
    expect(styles.code_block).toMatchObject({
      userSelect: "text",
    });
    expect(styles.fence).toMatchObject({
      userSelect: "text",
    });
    expect(styles.bullet_list_icon).toMatchObject({
      userSelect: "text",
    });
    expect(styles.ordered_list_icon).toMatchObject({
      userSelect: "text",
    });
  });

  it("keeps heading line heights above the CJK glyph box at every UI font size", () => {
    // 24 / 16 is the top of the appearance UI font-size range.
    for (const theme of [darkTheme, withScaledFontRamp(darkTheme, 24 / 16)]) {
      for (const create of [createMarkdownStyles, createCompactMarkdownStyles]) {
        const styles = create(theme);
        for (const key of HEADING_KEYS) {
          const { fontSize, lineHeight } = styles[key];
          expect(lineHeight / fontSize, `${create.name} ${key}`).toBeGreaterThanOrEqual(
            REQUIRED_MIN_RATIO,
          );
        }
      }
    }
  });

  it("scales list markers with the font-size ramp so they stay on the text baseline", () => {
    const styles = createMarkdownStyles(withScaledFontRamp(darkTheme, 24 / 16));

    expect(
      styles.bullet_list_icon.lineHeight / styles.bullet_list_icon.fontSize,
    ).toBeGreaterThanOrEqual(REQUIRED_MIN_RATIO);
    expect(
      styles.ordered_list_icon.lineHeight / styles.ordered_list_icon.fontSize,
    ).toBeGreaterThanOrEqual(REQUIRED_MIN_RATIO);
  });

  it("uses the mono font-size token directly for inline and block code", () => {
    const styles = createMarkdownStyles(darkTheme);
    const compactStyles = createCompactMarkdownStyles(darkTheme);

    expect(styles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
      lineHeight: Math.ceil(darkTheme.fontSize.code * REQUIRED_MIN_RATIO),
    });
    expect(styles.code_block).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(styles.fence).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(compactStyles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
      lineHeight: Math.ceil(darkTheme.fontSize.code * REQUIRED_MIN_RATIO),
    });
  });
});
