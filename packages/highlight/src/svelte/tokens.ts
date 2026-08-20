import { ContextTracker, ExternalTokenizer, type InputStream, type Stack } from "@lezer/lr";
import {
  commentContent$1,
  Element,
  IncompleteCloseTag,
  LongExpression,
  MismatchedStartCloseTag,
  missingCloseTag,
  OpenTag,
  scriptText,
  ShortExpression,
  StartCloseScriptTag,
  StartCloseStyleTag,
  StartCloseTag,
  StartCloseTextareaTag,
  StartScriptTag,
  StartSelfClosingTag,
  StartStyleTag,
  StartTag,
  StartTextareaTag,
  styleText,
  textareaText,
} from "./terms.js";

const selfClosers: Record<string, boolean> = {
  area: true,
  base: true,
  br: true,
  col: true,
  command: true,
  embed: true,
  frame: true,
  hr: true,
  img: true,
  input: true,
  keygen: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
  menuitem: true,
};

const implicitlyClosed: Record<string, boolean> = {
  dd: true,
  li: true,
  optgroup: true,
  option: true,
  p: true,
  rp: true,
  rt: true,
  tbody: true,
  td: true,
  tfoot: true,
  th: true,
  tr: true,
};

const closeOnOpen: Record<string, Record<string, boolean>> = {
  dd: { dd: true, dt: true },
  dt: { dd: true, dt: true },
  li: { li: true },
  option: { option: true, optgroup: true },
  optgroup: { optgroup: true },
  p: {
    address: true,
    article: true,
    aside: true,
    blockquote: true,
    dir: true,
    div: true,
    dl: true,
    fieldset: true,
    footer: true,
    form: true,
    h1: true,
    h2: true,
    h3: true,
    h4: true,
    h5: true,
    h6: true,
    header: true,
    hgroup: true,
    hr: true,
    menu: true,
    nav: true,
    ol: true,
    p: true,
    pre: true,
    section: true,
    table: true,
    ul: true,
  },
  rp: { rp: true, rt: true },
  rt: { rp: true, rt: true },
  tbody: { tbody: true, tfoot: true },
  td: { td: true, th: true },
  tfoot: { tbody: true },
  th: { td: true, th: true },
  thead: { tbody: true, tfoot: true },
  tr: { tr: true },
};

function nameChar(ch: number): boolean {
  return (
    ch === 45 ||
    ch === 46 ||
    ch === 58 ||
    (ch >= 65 && ch <= 90) ||
    ch === 95 ||
    (ch >= 97 && ch <= 122) ||
    ch >= 161
  );
}

function isSpace(ch: number): boolean {
  return ch === 9 || ch === 10 || ch === 13 || ch === 32;
}

const lessThan = 60;
const greaterThan$1 = 62;
const slash$1 = 47;
const question = 63;
const bang = 33;

let cachedName: string | null | undefined = null;
let cachedInput: InputStream | null = null;
let cachedPos = 0;

function tagNameAfter(input: InputStream, offset: number): string | null | undefined {
  const pos = input.pos + offset;
  if (cachedPos === pos && cachedInput === input) return cachedName;
  let next = input.peek(offset);
  let curOffset = offset;
  while (isSpace(next)) {
    curOffset++;
    next = input.peek(curOffset);
  }
  let name = "";
  for (;;) {
    if (!nameChar(next)) break;
    name += String.fromCharCode(next);
    curOffset++;
    next = input.peek(curOffset);
  }
  cachedInput = input;
  cachedPos = pos;
  let result: string | null | undefined;
  if (name) {
    result = name.toLowerCase();
  } else if (next === question || next === bang) {
    result = undefined;
  } else {
    result = null;
  }
  cachedName = result;
  return result;
}

export class ElementContext {
  name: string;
  parent: ElementContext | null;
  hash: number;

  constructor(name: string, parent: ElementContext | null) {
    this.name = name;
    this.parent = parent;
    this.hash = parent ? parent.hash : 0;
    for (let i = 0; i < name.length; i++) {
      this.hash += (this.hash << 4) + name.charCodeAt(i) + (name.charCodeAt(i) << 8);
    }
  }
}

const startTagTerms = new Set([
  StartTag,
  StartSelfClosingTag,
  StartScriptTag,
  StartStyleTag,
  StartTextareaTag,
]);

export const elementContext = new ContextTracker<ElementContext | null>({
  start: null,
  shift(context, term, _stack, input) {
    return startTagTerms.has(term)
      ? new ElementContext(tagNameAfter(input, 1) || "", context)
      : context;
  },
  reduce(context, term) {
    return term === Element && context ? context.parent : context;
  },
  reuse(context, node, _stack, input) {
    const type = node.type.id;
    return type === StartTag || type === OpenTag
      ? new ElementContext(tagNameAfter(input, 1) || "", context)
      : context;
  },
  hash(context) {
    return context ? context.hash : 0;
  },
  strict: false,
});

export const tagStart = new ExternalTokenizer(
  // oxlint-disable-next-line complexity -- vendored Lezer tokenizer
  (input: InputStream, stack: Stack) => {
    if (input.next !== lessThan) {
      if (input.next < 0 && stack.context) input.acceptToken(missingCloseTag);
      return;
    }
    input.advance();
    const close = (input.next as number) === slash$1;
    if (close) input.advance();
    const name = tagNameAfter(input, 0);
    if (name === undefined) return;
    if (!name) {
      input.acceptToken(close ? IncompleteCloseTag : StartTag);
      return;
    }

    const parent = stack.context ? (stack.context as ElementContext).name : null;
    if (close) {
      if (name === parent) {
        input.acceptToken(StartCloseTag);
        return;
      }
      if (parent && implicitlyClosed[parent]) {
        input.acceptToken(missingCloseTag, -2);
        return;
      }
      for (
        let cx: ElementContext | null = stack.context as ElementContext | null;
        cx;
        cx = cx.parent
      ) {
        if (cx.name === name) return;
      }
      input.acceptToken(MismatchedStartCloseTag);
    } else {
      if (name === "script") {
        input.acceptToken(StartScriptTag);
        return;
      }
      if (name === "style") {
        input.acceptToken(StartStyleTag);
        return;
      }
      if (name === "textarea") {
        input.acceptToken(StartTextareaTag);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(selfClosers, name)) {
        input.acceptToken(StartSelfClosingTag);
        return;
      }
      if (parent && closeOnOpen[parent]?.[name]) {
        input.acceptToken(missingCloseTag, -1);
      } else {
        input.acceptToken(StartTag);
      }
    }
  },
  { contextual: true },
);

function contentTokenizer(tag: string, textToken: number, endToken: number): ExternalTokenizer {
  const lastState = 2 + tag.length;
  return new ExternalTokenizer((input) => {
    for (let state = 0, matchedLen = 0, i = 0; ; i++) {
      if (input.next < 0) {
        if (i) input.acceptToken(textToken);
        break;
      }
      if (
        (state === 0 && input.next === lessThan) ||
        (state === 1 && input.next === slash$1) ||
        (state >= 2 && state < lastState && input.next === tag.charCodeAt(state - 2))
      ) {
        state++;
        matchedLen++;
      } else if ((state === 2 || state === lastState) && isSpace(input.next)) {
        matchedLen++;
      } else if (state === lastState && input.next === greaterThan$1) {
        if (i > matchedLen) input.acceptToken(textToken, -matchedLen);
        else input.acceptToken(endToken, -(matchedLen - 2));
        break;
      } else if ((input.next === 10 || input.next === 13) && i) {
        input.acceptToken(textToken, 1);
        break;
      } else {
        state = 0;
        matchedLen = 0;
      }
      input.advance();
    }
  });
}

export const scriptTokens = contentTokenizer("script", scriptText, StartCloseScriptTag);
export const styleTokens = contentTokenizer("style", styleText, StartCloseStyleTag);
export const textareaTokens = contentTokenizer("textarea", textareaText, StartCloseTextareaTag);

const space = new Set([
  9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12288,
]);
const parenOpen = 40;
const parenClose = 41;
const squareOpen = 91;
const squareClose = 93;
const curlyOpen = 123;
const curlyClose = 125;
const comma = 44;
const colon = 58;
const hash = 35;
const at = 64;
const slash = 47;
const greaterThan = 62;
const dash = 45;
const quoteDouble = 34;
const quoteSingle = 39;
const backslash = 92;
const newline = 10;
const asterisk = 42;
const tick = 96;
const prefixes = new Set([colon, hash, at, slash]);

export const commentContent = new ExternalTokenizer((input) => {
  for (let dashes = 0, i = 0; ; i++) {
    if (input.next < 0) {
      if (i) input.acceptToken(commentContent$1);
      break;
    }
    if (input.next === dash) {
      dashes++;
    } else if (input.next === greaterThan && dashes >= 2) {
      if (i > 3) input.acceptToken(commentContent$1, -2);
      break;
    } else {
      dashes = 0;
    }
    input.advance();
  }
});

function createStringHandler(input: InputStream) {
  let inString = false;
  let inStringType: "double" | "single" | "template" | null = null;
  let inStringIgnoreNext = false;
  return () => {
    if (inString) {
      if (inStringIgnoreNext) {
        inStringIgnoreNext = false;
        return true;
      }
      if (input.next === backslash) {
        inStringIgnoreNext = true;
        return true;
      }
      if (inStringType === "double" && input.next === quoteDouble) {
        inString = false;
        inStringType = null;
        return true;
      }
      if (inStringType === "single" && input.next === quoteSingle) {
        inString = false;
        inStringType = null;
        return true;
      }
      if (inStringType === "template" && input.next === tick) {
        inString = false;
        inStringType = null;
        return true;
      }
      return true;
    }
    if (input.next === quoteDouble) {
      inString = true;
      inStringType = "double";
      return true;
    }
    if (input.next === quoteSingle) {
      inString = true;
      inStringType = "single";
      return true;
    }
    if (input.next === tick) {
      inString = true;
      inStringType = "template";
      return true;
    }
    return false;
  };
}

function createCommentHandler(input: InputStream) {
  let inLineComment = false;
  let inBlockComment = false;
  return () => {
    if (inLineComment) {
      if (input.next === newline) {
        inLineComment = false;
        return true;
      }
      return true;
    }
    if (inBlockComment) {
      if (input.next === asterisk && input.peek(1) === slash) {
        inBlockComment = false;
        return true;
      }
      return true;
    }
    if (input.next === slash && input.peek(1) === slash) {
      inLineComment = true;
      return true;
    }
    if (input.next === slash && input.peek(1) === asterisk) {
      inBlockComment = true;
      return true;
    }
    return false;
  };
}

export const longExpression = new ExternalTokenizer((input) => {
  if (prefixes.has(input.next)) {
    return;
  }
  const commentHandler = createCommentHandler(input);
  const stringHandler = createStringHandler(input);
  const stack: ("(" | "{" | "[")[] = [];
  const popIfMatch = (match: "(" | "{" | "[") => {
    const idx = stack.lastIndexOf(match);
    if (idx !== -1) {
      while (stack.length > idx) {
        stack.pop();
      }
    }
  };
  for (let pos = 0; ; pos++) {
    if (input.next < 0) {
      if (pos > 0) input.acceptToken(LongExpression);
      break;
    }
    if (commentHandler() || stringHandler()) {
      input.advance();
      continue;
    }
    if (
      stack.length === 0 &&
      (input.next === curlyClose || input.next === parenClose || input.next === squareClose)
    ) {
      input.acceptToken(LongExpression);
      break;
    }
    switch (input.next) {
      case parenOpen:
        stack.push("(");
        break;
      case parenClose:
        popIfMatch("(");
        break;
      case squareOpen:
        stack.push("[");
        break;
      case squareClose:
        popIfMatch("[");
        break;
      case curlyOpen:
        stack.push("{");
        break;
      case curlyClose:
        popIfMatch("{");
        break;
    }
    input.advance();
  }
});

// oxlint-disable-next-line complexity -- vendored Lezer tokenizer
export const shortExpression = new ExternalTokenizer((input) => {
  if (prefixes.has(input.peek(0))) {
    return;
  }
  const commentHandler = createCommentHandler(input);
  const stringHandler = createStringHandler(input);
  const stack: ("(" | "{" | "[")[] = [];
  const popIfMatch = (match: "(" | "{" | "[") => {
    const idx = stack.lastIndexOf(match);
    if (idx !== -1) {
      while (stack.length > idx) {
        stack.pop();
      }
    }
  };
  for (let pos = 0; ; pos++) {
    if (input.next < 0) {
      if (pos > 0) input.acceptToken(ShortExpression);
      break;
    }
    if (commentHandler() || stringHandler()) {
      input.advance();
      continue;
    }
    if (
      stack.length === 0 &&
      (input.next === curlyClose ||
        input.next === parenClose ||
        input.next === squareClose ||
        input.next === comma)
    ) {
      input.acceptToken(ShortExpression);
      break;
    }
    switch (input.next) {
      case parenOpen:
        stack.push("(");
        break;
      case parenClose:
        popIfMatch("(");
        break;
      case squareOpen:
        stack.push("[");
        break;
      case squareClose:
        popIfMatch("[");
        break;
      case curlyOpen:
        stack.push("{");
        break;
      case curlyClose:
        popIfMatch("{");
        break;
    }
    if (pos !== 0 && stack.length === 0 && space.has(input.next)) {
      input.acceptToken(ShortExpression);
      break;
    }
    input.advance();
  }
});
