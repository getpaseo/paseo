import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { StyleProp, TextStyle } from "react-native";

export function colorMarkdownLinkChildren(
  children: ReactNode,
  color: TextStyle["color"],
): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ style?: StyleProp<TextStyle> }>(child)) return child;
    return cloneElement(child, { style: [child.props.style, { color }] });
  });
}

const MARKDOWN_LINK_HOVER_STYLE: TextStyle = { textDecorationLine: "underline" };

export function markdownLinkTextStyle(
  style: StyleProp<TextStyle>,
  hovered: boolean,
): StyleProp<TextStyle> {
  return [style, hovered && MARKDOWN_LINK_HOVER_STYLE];
}
