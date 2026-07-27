import { describe, expect, it } from "vitest";
import {
  createCompactMarkdownStyles,
  createMarkdownStyles,
  createThinkingMarkdownStyles,
} from "./markdown-styles";
import { darkTheme } from "./theme";

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

  it("keeps thinking prose on the reply line-height with muted color and tight paragraphs", () => {
    const styles = createThinkingMarkdownStyles(darkTheme);

    expect(styles.body).toMatchObject({
      color: darkTheme.colors.foregroundMuted,
      fontSize: darkTheme.fontSize.base,
      lineHeight: Math.round(darkTheme.fontSize.base * 1.4),
    });
    expect(styles.text).toMatchObject({
      color: darkTheme.colors.foregroundMuted,
    });
    expect(styles.paragraph).toMatchObject({
      marginBottom: darkTheme.spacing[1],
    });
  });

  it("uses the mono font-size token directly for inline and block code", () => {
    const styles = createMarkdownStyles(darkTheme);
    const compactStyles = createCompactMarkdownStyles(darkTheme);

    expect(styles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
      lineHeight: Math.round(darkTheme.fontSize.code * 1.45),
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
      lineHeight: Math.round(darkTheme.fontSize.code * 1.45),
    });
  });

  it("keeps reply prose on the continuous / related vertical rhythm", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.paragraph).toMatchObject({
      marginBottom: darkTheme.spacing[2],
    });
    expect(styles.heading2).toMatchObject({
      marginTop: darkTheme.spacing[4],
      marginBottom: darkTheme.spacing[2],
    });
    expect(styles.table).toMatchObject({
      marginVertical: darkTheme.spacing[2],
    });
  });

  it("overrides library light fence defaults with theme surface colors", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.fence).toMatchObject({
      backgroundColor: darkTheme.colors.surface2,
      borderColor: darkTheme.colors.border,
      borderWidth: darkTheme.borderWidth[1],
      color: darkTheme.colors.foreground,
      marginVertical: darkTheme.spacing[2],
    });
    expect(styles.code_block).toMatchObject({
      backgroundColor: darkTheme.colors.surface2,
      borderColor: darkTheme.colors.border,
      borderWidth: darkTheme.borderWidth[1],
      color: darkTheme.colors.foreground,
      marginVertical: darkTheme.spacing[2],
    });
    expect(styles.fence.backgroundColor).not.toBe("#f5f5f5");
    expect(styles.code_block.backgroundColor).not.toBe("#f5f5f5");
  });
});
