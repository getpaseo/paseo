import {
  continuedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  LRLanguage,
} from "@codemirror/language";
import { parser } from "./parser.js";

export const csharpLanguage = LRLanguage.define({
  name: "C#",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Delim: continuedIndent({ except: /^\s*(?:case\b|default:)/ }),
      }),
      foldNodeProp.add({
        Delim: foldInside,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"', "'"] },
    indentOnInput: /^\s*((\)|\]|\})$|(else|else\s+if|catch|finally|case)\b|default:)/,
  },
});
