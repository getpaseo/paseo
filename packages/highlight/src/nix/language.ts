import {
  continuedIndent,
  delimitedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  LRLanguage,
} from "@codemirror/language";
import { parser } from "./parser.js";

export const nixLanguage = LRLanguage.define({
  name: "Nix",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Parenthesized: delimitedIndent({ closing: ")" }),
        AttrSet: delimitedIndent({ closing: "}" }),
        List: delimitedIndent({ closing: "]" }),
        Let: continuedIndent({ except: /^\s*in\b/ }),
      }),
      foldNodeProp.add({
        AttrSet: foldInside,
        List: foldInside,
        Let(node) {
          const first = node.getChild("let");
          const last = node.getChild("in");
          if (!first || !last) return null;
          return { from: first.to, to: last.from };
        },
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "#", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", "''", '"'] },
    indentOnInput: /^\s*(in|\}|\)|\])$/,
  },
});
