import createMd4c from './wasm/md4c';
"use strict";

// Caching the Promise (not the resolved value) means concurrent callers share
// a single WASM initialization — no duplicate loading.
let readyParser = null;
let parserPromise = null;

// SINGLE_FILE=1 inlines the WASM binary as base64 inside md4c.js, so no
// network fetch is needed — only a one-time decode + compile on first call.
function initializeParser() {
  if (!parserPromise) {
    parserPromise = Promise.resolve().then(() => createMd4c()).then(wasmModule => wasmModule.cwrap('parseMarkdown', 'string', ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'])).then(parse => {
      readyParser = parse;
      return parse;
    }).catch(error => {
      parserPromise = null;
      throw error;
    });
  }
  return parserPromise;
}
function isASTNode(value) {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}
export function parseMarkdownSync(markdown, {
  underline = false,
  latexMath = true,
  superscript = false,
  subscript = false,
  highlight = false,
  hardSoftBreaks = false,
  preserveBlankLines = false,
  admonitions = true
} = {}) {
  const parse = readyParser;
  if (!parse) return null;
  const result = JSON.parse(parse(markdown, underline ? 1 : 0, latexMath ? 1 : 0, superscript ? 1 : 0, subscript ? 1 : 0, highlight ? 1 : 0, hardSoftBreaks ? 1 : 0, preserveBlankLines ? 1 : 0, admonitions ? 1 : 0));
  if (!isASTNode(result)) {
    throw new Error('WASM parser returned invalid AST');
  }
  return result;
}
export async function parseMarkdown(markdown, flags = {}) {
  await initializeParser();
  return parseMarkdownSync(markdown, flags);
}
//# sourceMappingURL=parseMarkdown.js.map