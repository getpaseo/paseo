/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { createElement, type ReactNode } from "react";
import { fireEvent, render } from "@testing-library/react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { resolveInlineImageSize } from "./inline-image-size";
import { colorMarkdownLinkChildren } from "./link-children";
import { MarkdownLinkText } from "./link-text";

vi.stubGlobal("React", React);

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityRole,
    children,
    onHoverIn,
    onHoverOut,
    onPress,
  }: {
    accessibilityRole?: string;
    children?: ReactNode;
    onHoverIn?(): void;
    onHoverOut?(): void;
    onPress?(): void;
  }) =>
    createElement(
      "div",
      {
        role: accessibilityRole,
        onClick: onPress,
        onMouseEnter: onHoverIn,
        onMouseLeave: onHoverOut,
      },
      children,
    ),
  Text: ({ children, style }: { children?: ReactNode; style?: StyleProp<TextStyle> }) =>
    createElement("span", { style: flattenStyle(style) }, children),
}));

function flattenStyle(style: StyleProp<TextStyle>): TextStyle {
  return Object.assign({}, ...(Array.isArray(style) ? style.filter(Boolean) : [style]));
}

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
  it("renders accent text and underlines it while hovered", () => {
    const onPress = vi.fn();
    const children = colorMarkdownLinkChildren(
      createElement(Text, { style: { color: "white" } }, "Paseo"),
      "rgb(0, 122, 255)",
    );
    const view = render(
      createElement(MarkdownLinkText, { style: { color: "rgb(0, 122, 255)" }, onPress }, children),
    );
    const link = view.getByRole("link");
    const linkText = link.firstElementChild as HTMLElement;

    expect((view.getByText("Paseo") as HTMLElement).style.color).toBe("rgb(0, 122, 255)");
    expect(linkText.style.textDecorationLine).toBe("");

    fireEvent.mouseEnter(link);
    expect(linkText.style.textDecorationLine).toBe("underline");

    fireEvent.mouseLeave(link);
    expect(linkText.style.textDecorationLine).toBe("");

    fireEvent.click(link);
    expect(onPress).toHaveBeenCalledOnce();
  });
});
