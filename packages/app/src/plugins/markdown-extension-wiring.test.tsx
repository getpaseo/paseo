import type { PluginMarkdownExtension } from "@getpaseo/plugin/client";
import {
  createElement,
  Fragment,
  isValidElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { StyleSheet, type StyleProp, type TextStyle } from "react-native";
import AstRenderer from "react-native-markdown-display/src/lib/AstRenderer";
import parser from "react-native-markdown-display/src/lib/parser";
import { describe, expect, it } from "vitest";
import {
  applyMarkdownExtensionParsers,
  mergeMarkdownExtensionRules,
} from "@/plugins/markdown-extensions";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { darkTheme, lightTheme, type Theme } from "@/styles/theme";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";

// Stands in for whatever a plugin renders. `plugin-examples/markdown-extension` is the shipped
// worked example; this file pins the host wiring underneath it, which no example can assert:
// that a contributed parser and rule reach a real AstRenderer, and that the rule's fifth
// argument carries the text style it inherited — the only way prose color reaches a token that
// has no text of its own.
const Probe: ComponentType<{ textStyle?: StyleProp<TextStyle> }> = () => null;

const PROBE_MARKER = "@@";
const probeExtension: PluginMarkdownExtension = {
  id: "probe",
  parser: (markdown) => {
    markdown.inline.ruler.before("escape", "probe_inline", (state, silent) => {
      if (!state.src.startsWith(PROBE_MARKER, state.pos)) return false;
      if (!silent) state.push("probe_inline", "span", 0);
      state.pos += PROBE_MARKER.length;
      return true;
    });
  },
  rules: {
    probe_inline: (node, _children, _parent, _styles, inheritedStyles) =>
      createElement(Probe, { key: node.key, textStyle: inheritedStyles }),
  },
};

function collectProbeColors(markdown: string, theme: Theme): (string | undefined)[] {
  const passThrough = (node: { key: string }, children: ReactNode[]) =>
    createElement(Fragment, { key: node.key }, children);
  const rules = mergeMarkdownExtensionRules(
    {
      body: passThrough,
      paragraph: passThrough,
      textgroup: passThrough,
      blockquote: passThrough,
      text: () => null,
      // Collides with the extension's rule on purpose: the extension has to win, or a token
      // type the host already knows could never be re-rendered by a plugin.
      probe_inline: () => null,
    },
    [probeExtension],
  );
  const renderer = new AstRenderer(rules, createMarkdownStyles(theme));
  const { parser: markdownIt } = applyMarkdownExtensionParsers(createAssistantMarkdownParser, [
    probeExtension,
  ]);

  const colors: (string | undefined)[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{
      textStyle?: StyleProp<TextStyle>;
      children?: ReactNode;
    }>;
    if (element.type === Probe) {
      colors.push(StyleSheet.flatten(element.props.textStyle)?.color as string | undefined);
      return;
    }
    walk(element.props.children);
  };
  walk(parser(markdown, renderer.render, markdownIt));
  return colors;
}

const colorOf = (style: StyleProp<TextStyle>) => StyleSheet.flatten(style)?.color;

describe.each<[string, Theme]>([
  ["dark", darkTheme],
  ["light", lightTheme],
])("a markdown extension through the host (%s theme)", (_name, theme) => {
  it("routes a contributed token to the contributed rule", () => {
    expect(collectProbeColors("Prose @@ and more.\n", theme)).toHaveLength(1);
  });

  it("hands the rule the prose text style around it", () => {
    const styles = createMarkdownStyles(theme);

    expect(collectProbeColors("Prose @@ and @@ again.\n", theme)).toEqual([
      colorOf(styles.body),
      colorOf(styles.body),
    ]);
  });

  it("follows a blockquote's color override when nested in one", () => {
    const styles = createMarkdownStyles(theme);

    expect(collectProbeColors("> @@\n", theme)).toEqual([
      colorOf(styles.blockquote) ?? colorOf(styles.body),
    ]);
  });
});

describe("a markdown extension through the host", () => {
  it("uses a different color in each theme, so a rendered token stays legible on either background", () => {
    const dark = collectProbeColors("@@\n", darkTheme);
    const light = collectProbeColors("@@\n", lightTheme);

    expect(dark[0]).toBe(darkTheme.colors.foreground);
    expect(light[0]).toBe(lightTheme.colors.foreground);
    expect(dark[0]).not.toBe(light[0]);
  });
});
