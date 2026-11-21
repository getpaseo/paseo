import {
  delimitedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  LRLanguage,
} from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { parser } from "./parser.js";

export const hclLanguage = LRLanguage.define({
  name: "HCL",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Block: delimitedIndent({ closing: "}", align: false }),
      }),
      foldNodeProp.add({
        "Object Tuple TemplateFor TemplateIf": foldInside,
        BlockComment: (tree: SyntaxNode) => {
          return { from: tree.from + 2, to: tree.to - 2 };
        },
        HeredocTemplate(tree: SyntaxNode) {
          const start = tree.getChild("HeredocIdentifier");
          if (!start) {
            return null;
          }
          return {
            from: start.to,
            to: tree.to,
          };
        },
        FunctionCall(tree: SyntaxNode) {
          const start = tree.getChild("(");
          const end = tree.getChild(")");
          if (!start || !end) {
            return null;
          }
          return {
            from: start.from + 1,
            to: end.to - 1,
          };
        },
        Block(tree: SyntaxNode) {
          const start = tree.getChild("{");
          const end = tree.getChild("}");
          if (!start || !end) {
            return null;
          }
          return {
            from: start.from + 1,
            to: end.to - 1,
          };
        },
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "#", block: { open: "/*", close: "*/" } },
  },
});
