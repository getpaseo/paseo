import { describe, expect, it } from "vitest";
import { createCompactMarkdownStyles, createMarkdownStyles } from "./markdown-styles";
import { darkTheme } from "./theme";

describe("createMarkdownStyles", () => {
  it("uses the standard interface size for conversation prose and list markers", () => {
    const styles = createMarkdownStyles(darkTheme);
    const proseLineHeight = Math.round(darkTheme.fontSize.sm * 1.4);

    expect(styles.body).toMatchObject({
      fontSize: darkTheme.fontSize.sm,
      lineHeight: proseLineHeight,
    });
    expect(styles.bullet_list_icon).toMatchObject({
      fontSize: darkTheme.fontSize.sm,
      lineHeight: proseLineHeight,
    });
    expect(styles.ordered_list_icon).toMatchObject({
      fontSize: darkTheme.fontSize.sm,
      lineHeight: proseLineHeight,
    });
  });

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

  it("uses the mono font-size token directly for inline and block code", () => {
    const styles = createMarkdownStyles(darkTheme);
    const compactStyles = createCompactMarkdownStyles(darkTheme);

    expect(styles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(styles.code_inline).not.toHaveProperty("lineHeight");
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
    });
    expect(compactStyles.code_inline).not.toHaveProperty("lineHeight");
  });
});
