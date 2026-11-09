import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { PluggableList } from "unified";
import { remarkHeadingIds } from "./docs-anchor-ids.js";
import { remarkDocsExample } from "./docs-example-directive.js";

export const docsRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkDirective,
  remarkDocsExample,
  remarkHeadingIds,
];

let docsHighlighter: Promise<HighlighterCore> | undefined;

export function getDocsHighlighter(): Promise<HighlighterCore> {
  docsHighlighter ??= Promise.all([
    import("shiki/themes/catppuccin-mocha.mjs"),
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/tsx.mjs"),
    import("shiki/langs/yaml.mjs"),
    import("shiki/langs/markdown.mjs"),
  ]).then(([theme, bash, json, javascript, typescript, tsx, yaml, markdown]) =>
    createHighlighterCore({
      themes: [theme.default],
      langs: [
        bash.default,
        json.default,
        javascript.default,
        typescript.default,
        tsx.default,
        yaml.default,
        markdown.default,
      ],
      engine: createJavaScriptRegexEngine(),
    }),
  );
  return docsHighlighter;
}

/** Rehype plugins for docs, with the heading anchor's accessible name in the page language. */
export function docsRehypePlugins(anchorLabel: string): PluggableList {
  return [
    rehypeSlug,
    [
      rehypeAutolinkHeadings,
      {
        behavior: "prepend",
        properties: { className: "heading-anchor", ariaLabel: anchorLabel },
        content: {
          type: "element",
          tagName: "span",
          properties: { className: "heading-anchor-icon", ariaHidden: "true" },
          children: [{ type: "text", value: "#" }],
        },
      },
    ],
  ];
}
