import React, { isValidElement, type ReactElement } from "react";

(globalThis as { React?: typeof React }).React = React;
import { Text } from "react-native";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import type { PluginClientContext, PluginMarkdownExtension } from "@getpaseo/plugin/client";
import contribute from "../../../../plugin-examples/markdown-extension/index.client";
import { applyMarkdownExtensionParsers } from "./markdown-extensions";

function installExample(): PluginMarkdownExtension {
  let extension: PluginMarkdownExtension | undefined;
  contribute({
    addMarkdownExtension(next: PluginMarkdownExtension) {
      extension = next;
      return () => undefined;
    },
  } as PluginClientContext);
  if (!extension) throw new Error("example did not register a markdown extension");
  return extension;
}

describe("plugin-examples/markdown-extension", () => {
  it("closes a badge_block when an unescaped ::: appears on a line", () => {
    const extension = installExample();
    const { parser } = applyMarkdownExtensionParsers(() => new MarkdownIt(), [extension]);
    const tokens = parser.parse(":::\ntext ::: literal\n\nstill inside\n:::", {});
    const blocks = tokens.filter((token) => token.type === "badge_block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).not.toContain("still inside");
    expect(tokens.some((token) => token.content.includes("still inside"))).toBe(true);
  });

  it("applies inherited prose styles to badge_block text", () => {
    const extension = installExample();
    const inheritedStyles = { color: "#abc123" };
    const node = { key: "badge", content: "hello" };
    const rendered = extension.rules?.badge_block?.(
      node as never,
      [],
      [],
      {} as never,
      inheritedStyles as never,
    );
    expect(isValidElement(rendered)).toBe(true);
    const view = rendered as ReactElement<{ children?: unknown }>;
    const text = view.props.children as ReactElement<{ style?: { color?: string } }>;
    expect(text.type).toBe(Text);
    expect(text.props.style).toEqual(inheritedStyles);
  });
});
