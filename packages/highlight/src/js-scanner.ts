// Scans JavaScript embedded in a template (Astro `{ }` expressions, Vue `{{ }}`
// interpolations) for the brace that closes it, without parsing the code.

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isRegexStart(text: string, position: number): boolean {
  let previous = position - 1;
  while (previous >= 0 && isSpace(text.charCodeAt(previous))) previous--;
  if (previous < 0) return true;

  const character = text[previous];
  if (/[)\]}<"'`\d]/.test(character)) return false;
  const code = text.charCodeAt(previous);
  if (code === 62) return previous > 0 && text.charCodeAt(previous - 1) === 61;
  if (!/[A-Za-z_$]/.test(character)) return true;

  let start = previous;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start--;
  const keyword = text.slice(start + 1, previous + 1);
  return /^(return|typeof|instanceof|in|of|new|void|delete|yield|await|case|do|else|throw|extends|assert|with)$/.test(
    keyword,
  );
}

// Template strings nested deeper than this are treated as running to the end.
const MAX_TEMPLATE_NESTING = 32;

function skipQuotedText(text: string, opening: number, nesting = 0): number {
  const quote = text.charCodeAt(opening);
  for (let position = opening + 1; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 92) position++;
    else if (code === quote) return position;
    else if (quote === 96 && code === 36 && text.charCodeAt(position + 1) === 123) {
      position = skipTemplateSubstitution(text, position + 2, nesting);
    }
  }
  return text.length - 1;
}

function skipTemplateSubstitution(text: string, start: number, nesting: number): number {
  if (nesting >= MAX_TEMPLATE_NESTING) return text.length - 1;
  const closing = findClosingBrace(text, start, () => true, nesting + 1);
  return closing >= 0 ? closing : text.length - 1;
}

function skipLineComment(text: string, opening: number): number {
  const newline = text.indexOf("\n", opening + 2);
  return newline >= 0 ? newline : text.length - 1;
}

function skipBlockComment(text: string, opening: number): number {
  const closing = text.indexOf("*/", opening + 2);
  return closing >= 0 ? closing + 1 : text.length - 1;
}

function skipRegex(text: string, opening: number): number {
  let isInCharacterClass = false;
  for (let position = opening + 1; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 10 || code === 13) return position;
    if (code === 92) position++;
    else if (isInCharacterClass && code === 93) isInCharacterClass = false;
    else if (!isInCharacterClass && code === 91) isInCharacterClass = true;
    else if (!isInCharacterClass && code === 47) return position;
  }
  return text.length - 1;
}

// Finds the first `}` outside nested braces, strings, comments, and regexes
// for which `isEnd` holds.
export function findClosingBrace(
  text: string,
  start: number,
  isEnd: (position: number) => boolean = () => true,
  nesting = 0,
): number {
  let depth = 0;
  for (let position = start; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 47 && text.charCodeAt(position + 1) === 47) {
      position = skipLineComment(text, position);
    } else if (code === 47 && text.charCodeAt(position + 1) === 42) {
      position = skipBlockComment(text, position);
    } else if (code === 47 && isRegexStart(text, position)) {
      position = skipRegex(text, position);
    } else if (code === 34 || code === 39 || code === 96) {
      position = skipQuotedText(text, position, nesting);
    } else if (code === 123) {
      depth++;
    } else if (code === 125 && depth === 0) {
      if (isEnd(position)) return position;
    } else if (code === 125) {
      depth--;
    }
  }
  return -1;
}
