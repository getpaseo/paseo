// Taken from codemirror-lang-hcl@0.2.0 (MIT, see LICENSE).
// Vendored for the same reason as packages/highlight/src/nix: only Lezer primitives load here.
import { ContextTracker, ExternalTokenizer, type InputStream } from "@lezer/lr";
import {
  QuotedTemplateStart,
  QuotedTemplateEnd,
  TemplateInterpolationStart,
  TemplateInterpolationEnd,
  TemplateDirectiveStart,
  TemplateDirectiveEnd,
  HeredocIdentifier,
  templateLiteralChunk,
} from "./terms.js";

const ContextType = {
  QUOTED_TEMPLATE: 1,
  TEMPLATE_INTERPOLATION: 2,
  TEMPLATE_DIRECTIVE: 4,
  HEREDOC_TEMPLATE: 8,
};

const hashStr = function (str: string) {
  var hash = 0,
    i,
    chr;
  if (str.length === 0) return hash;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};

class Context {
  readonly parent: Context | null;
  readonly type: number;
  readonly heredoc_identifier: string;
  readonly hash: number;

  constructor(parent: Context | null, type: number, heredoc_identifier: string) {
    this.parent = parent;
    this.type = type;
    this.heredoc_identifier = heredoc_identifier;
    this.hash =
      (parent ? (parent.hash + parent.hash) << 8 : 0) +
      (type << 4) +
      (this.heredoc_identifier === "" ? 0 : hashStr(this.heredoc_identifier));
  }
}

function readTokenText(input: InputStream, end: number): string {
  let text = "";
  for (let offset = 0; offset < end - input.pos; offset++) {
    text += String.fromCharCode(input.peek(offset));
  }
  return text;
}

const topCtx = new Context(null, 0, "");

export const trackTemplate = new ContextTracker({
  start: topCtx,
  shift(context, term, stack, input) {
    if (term === QuotedTemplateStart) {
      return new Context(context, ContextType.QUOTED_TEMPLATE, "");
    }
    if (term === TemplateInterpolationStart) {
      return new Context(context, ContextType.TEMPLATE_INTERPOLATION, "");
    }
    if (term === TemplateDirectiveStart) {
      return new Context(context, ContextType.TEMPLATE_DIRECTIVE, "");
    }
    if (term === HeredocIdentifier && context.type !== ContextType.HEREDOC_TEMPLATE) {
      const ctx = new Context(
        context,
        ContextType.HEREDOC_TEMPLATE,
        readTokenText(input, stack.pos),
      );
      return ctx;
    }

    if (term === HeredocIdentifier && context.type === ContextType.HEREDOC_TEMPLATE) {
      return context.parent ?? context;
    }
    switch (term) {
      case QuotedTemplateEnd:
      case TemplateInterpolationEnd:
      case TemplateDirectiveEnd:
        return context.parent ?? context;
    }

    return context;
  },
  hash(context) {
    return context.hash;
  },
});

const HEX_DIGIT = /[0-9a-fA-F]/;

function scanEscapeSequence(input: InputStream): void {
  input.advance();
  const kind = String.fromCharCode(input.next);
  if (kind === "u" || kind === "U") {
    const digits = kind === "u" ? 4 : 8;
    for (let i = 0; i < digits; i++) {
      input.advance();
      if (!HEX_DIGIT.test(String.fromCharCode(input.next))) return;
    }
  } else if (!'"nrt\\'.includes(kind)) {
    return;
  }
  input.advance();
  input.acceptToken(templateLiteralChunk);
}

function scanHeredocBody(input: InputStream, expected: string): void {
  let has_leading_whitespace_with_newline = false;
  let has_leading_whitespace = false;
  let next = String.fromCharCode(input.next);
  while (/\s/.test(next)) {
    has_leading_whitespace = true;
    if (next === "\n") {
      has_leading_whitespace_with_newline = true;
    }
    input.advance();
    next = String.fromCharCode(input.next);
  }
  if (has_leading_whitespace) {
    input.acceptToken(templateLiteralChunk);
  }

  if (!has_leading_whitespace_with_newline) {
    return;
  }

  let advance = 0;
  for (let i = 0; i < expected.length; i++) {
    if (String.fromCharCode(input.next) === expected[i]) {
      input.advance();
      advance++;
    } else {
      if (advance) {
        input.acceptToken(templateLiteralChunk);
      }
      return;
    }
  }

  // check if the identifier is on a line of its own
  let i = 0;
  while (true) {
    const ch = input.peek(i);
    if (ch == -1 || String.fromCharCode(ch) === "\n") {
      return input.acceptToken(HeredocIdentifier);
    }

    if (!/\s/.test(String.fromCharCode(ch))) {
      return input.acceptToken(templateLiteralChunk);
    }

    i++;
  }
}

// `$${` and `%%{` are escapes. The doubled marker counts only when `{` follows it, so in `$$${`
// the first `$` is literal text and the rest is the escape.
function scanTemplateMarker(input: InputStream, marker: string, startToken: number): void {
  input.advance();
  if (String.fromCharCode(input.next) === "{") {
    input.advance();
    return input.acceptToken(startToken);
  }
  if (String.fromCharCode(input.next) === marker && String.fromCharCode(input.peek(1)) === "{") {
    input.advance();
    input.advance();
  }
  input.acceptToken(templateLiteralChunk);
}

export const scanQuotedTemplateStart = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(QuotedTemplateStart) &&
      !(stack.context && stack.context.type === ContextType.QUOTED_TEMPLATE) &&
      String.fromCharCode(input.next) === '"'
    ) {
      input.advance();
      return input.acceptToken(QuotedTemplateStart);
    }
  },
  { contextual: true, fallback: true },
);
export const scanQuotedTemplateEnd = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(QuotedTemplateEnd) &&
      stack.context &&
      stack.context.type === ContextType.QUOTED_TEMPLATE &&
      String.fromCharCode(input.next) === '"'
    ) {
      input.advance();
      return input.acceptToken(QuotedTemplateEnd);
    }
  },
  { contextual: true, fallback: true },
);

export const scanTemplateLiteralChunk = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(templateLiteralChunk) &&
      stack.context &&
      stack.context.type === ContextType.QUOTED_TEMPLATE
    ) {
      if (String.fromCharCode(input.next) === "\\") {
        return scanEscapeSequence(input);
      }
    }

    if (
      stack.canShift(templateLiteralChunk) &&
      stack.context &&
      (stack.context.type === ContextType.QUOTED_TEMPLATE ||
        stack.context.type === ContextType.HEREDOC_TEMPLATE) &&
      input.next !== -1
    ) {
      input.advance();
      return input.acceptToken(templateLiteralChunk);
    }
  },
  { contextual: true, fallback: true },
);
export const scanTemplateInterpolationStart = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(TemplateInterpolationStart) &&
      stack.canShift(templateLiteralChunk) &&
      !(stack.context && stack.context.type === ContextType.TEMPLATE_INTERPOLATION) &&
      String.fromCharCode(input.next) === "$"
    ) {
      return scanTemplateMarker(input, "$", TemplateInterpolationStart);
    }
  },
  { contextual: true, fallback: true },
);
export const scanTemplateInterpolationEnd = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(TemplateInterpolationEnd) &&
      stack.context &&
      stack.context.type === ContextType.TEMPLATE_INTERPOLATION &&
      String.fromCharCode(input.next) === "}"
    ) {
      input.advance();
      return input.acceptToken(TemplateInterpolationEnd);
    }
  },
  { contextual: true, fallback: true },
);
export const scanTemplateDirectiveStart = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(TemplateDirectiveStart) &&
      stack.canShift(templateLiteralChunk) &&
      !(stack.context && stack.context.type === ContextType.TEMPLATE_DIRECTIVE) &&
      String.fromCharCode(input.next) === "%"
    ) {
      return scanTemplateMarker(input, "%", TemplateDirectiveStart);
    }
  },
  { contextual: true, fallback: true },
);
export const scanTemplateDirectiveEnd = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(TemplateDirectiveEnd) &&
      stack.context &&
      stack.context.type === ContextType.TEMPLATE_DIRECTIVE &&
      String.fromCharCode(input.next) === "}"
    ) {
      input.advance();
      return input.acceptToken(TemplateDirectiveEnd);
    }
  },
  { contextual: true, fallback: true },
);

export const scanHeredocIdentifier = new ExternalTokenizer(
  (input, stack) => {
    if (
      stack.canShift(HeredocIdentifier) &&
      !(stack.context && stack.context.type === ContextType.HEREDOC_TEMPLATE) &&
      input.next !== -1
    ) {
      let next = String.fromCharCode(input.next);
      while (/[\p{L}\p{N}_-]/u.test(next)) {
        input.advance();
        next = String.fromCharCode(input.next);
      }

      return input.acceptToken(HeredocIdentifier);
    }

    if (
      stack.canShift(HeredocIdentifier) &&
      stack.canShift(templateLiteralChunk) &&
      stack.context &&
      stack.context.type === ContextType.HEREDOC_TEMPLATE &&
      input.next != -1
    ) {
      return scanHeredocBody(input, stack.context.heredoc_identifier);
    }
  },
  { contextual: true, fallback: true },
);
