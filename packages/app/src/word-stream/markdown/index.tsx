import { useMemo } from "react";
import {
  renderRules,
  type ASTNode,
  type RenderRules,
  type RenderFunction,
} from "react-native-markdown-display";
import { WordFadeScope } from "..";
import type { SourceText } from "../internal/markdown-source";

function sourceText(node: ASTNode, offset: number): SourceText {
  if (node.children.length) {
    const children = node.children.map((child) => sourceText(child, offset));
    return {
      text: children.map((child) => child.text).join(""),
      offsets: children.flatMap((child) => child.offsets),
    };
  }
  if (node.type === "softbreak" || node.type === "hardbreak") return { text: "\n", offsets: [-1] };
  const meta = Reflect.get(node, "sourceMeta") as { wordSource?: number[] } | undefined;
  return { text: node.content, offsets: (meta?.wordSource ?? []).map((value) => value + offset) };
}

/** Keep mapping and animation ownership outside the presentation rules. */
export function useWordFadeRules(rules: RenderRules, sourceOffset: number): RenderRules {
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries({ ...renderRules, ...rules }).map(([name, rule]) => [
          name,
          rule &&
            ((...args: Parameters<NonNullable<typeof rule>>) => {
              const node = args[0];
              return (
                <WordFadeScope key={node.key} source={sourceText(node, sourceOffset)}>
                  {(rule as RenderFunction)(
                    args[0],
                    args[1],
                    args[2],
                    args[3],
                    args[4],
                    ...args.slice(5),
                  )}
                </WordFadeScope>
              );
            }),
        ]),
      ),
    [rules, sourceOffset],
  );
}
