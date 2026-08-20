import { styleTags, tags as t } from "@lezer/highlight";

export const nixHighlighting = styleTags({
  Identifier: t.propertyName,
  Boolean: t.bool,
  String: t.string,
  IndentedString: t.string,
  LineComment: t.lineComment,
  BlockComment: t.blockComment,
  Float: t.float,
  Integer: t.integer,
  Null: t.null,
  URI: t.url,
  SPath: t.literal,
  Path: t.literal,
  "( )": t.paren,
  "{ }": t.brace,
  "[ ]": t.squareBracket,
  "if then else": t.controlKeyword,
  "import with let in rec builtins inherit assert or": t.keyword,
});
