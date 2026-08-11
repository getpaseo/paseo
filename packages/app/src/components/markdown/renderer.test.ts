import { createElement, isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { resolveInlineImageSize } from "./inline-image-size";
import { colorMarkdownLinkChildren, markdownLinkTextStyle } from "./link-children";

describe("resolveInlineImageSize", () => {
  it("respects a one-sided explicit width using natural aspect ratio", () => {
    expect(
      resolveInlineImageSize({ explicit: { width: 18 }, natural: { width: 90, height: 45 } }),
    ).toEqual({
      width: 18,
      height: 9,
    });
  });

  it("respects a one-sided explicit height using natural aspect ratio", () => {
    expect(
      resolveInlineImageSize({ explicit: { height: 18 }, natural: { width: 90, height: 45 } }),
    ).toEqual({
      width: 36,
      height: 18,
    });
  });

  it("uses a generic small fallback when no dimensions are known", () => {
    expect(resolveInlineImageSize({ explicit: {}, natural: null })).toEqual({
      width: 16,
      height: 16,
    });
  });
});

describe("shared Markdown links", () => {
  it("applies the accent color to child text spans", () => {
    const child = createElement("span", { style: { color: "foreground" } }, "Paseo");
    const renderedChildren = colorMarkdownLinkChildren([child], "accent");
    const renderedChild = Array.isArray(renderedChildren) ? renderedChildren[0] : renderedChildren;
    if (!isValidElement<{ style: unknown }>(renderedChild)) {
      throw new Error("Markdown link color did not preserve its child element");
    }

    expect(renderedChild.props.style).toEqual([{ color: "foreground" }, { color: "accent" }]);
  });

  it("underlines link text while hovered", () => {
    expect(markdownLinkTextStyle({ color: "accent" }, true)).toEqual([
      { color: "accent" },
      { textDecorationLine: "underline" },
    ]);
  });
});
