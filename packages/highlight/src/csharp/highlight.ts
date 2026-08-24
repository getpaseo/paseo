import { styleTags, tags as t } from "@lezer/highlight";

export const csharpHighlighting = styleTags({
  "Keyword ContextualKeyword SimpleType": t.keyword,
  "NullLiteral BooleanLiteral": t.bool,
  IntegerLiteral: t.integer,
  RealLiteral: t.float,
  'StringLiteral CharacterLiteral InterpolatedRegularString InterpolatedVerbatimString $" @$" $@"':
    t.string,
  "LineComment BlockComment": t.comment,
  ". .. : Astrisk Slash % + - ++ -- Not ~ << & | ^ && || < > <= >= == NotEq = += -= *= SlashEq %= &= |= ^= ? ?? ??= =>":
    t.operator,
  PP_Directive: t.keyword,
  TypeIdentifier: t.typeName,
  "ArgumentName AttrsNamedArg": t.variableName,
  ConstName: t.constant(t.variableName),
  MethodName: t.function(t.variableName),
  ParamName: [t.emphasis, t.variableName],
  VarName: t.variableName,
  "FieldName PropertyName": t.propertyName,
  "( )": t.paren,
  "{ }": t.brace,
  "[ ]": t.squareBracket,
});
