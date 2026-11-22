import createMd4c from './wasm/md4c';
import type { ASTNode } from './types';
import type { Md4cFlags } from '../types/MarkdownStyle';

type ParseFn = (
  markdown: string,
  underline: number,
  latexMath: number,
  superscript: number,
  subscript: number,
  highlight: number,
  hardSoftBreaks: number,
  preserveBlankLines: number,
  admonitions: number
) => string;

// Caching the Promise (not the resolved value) means concurrent callers share
// a single WASM initialization — no duplicate loading.
let readyParser: ParseFn | null = null;
let parserPromise: Promise<ParseFn> | null = null;

// SINGLE_FILE=1 inlines the WASM binary as base64 inside md4c.js, so no
// network fetch is needed — only a one-time decode + compile on first call.
function initializeParser(): Promise<ParseFn> {
  if (!parserPromise) {
    parserPromise = Promise.resolve()
      .then(() => createMd4c())
      .then((wasmModule) =>
        wasmModule.cwrap('parseMarkdown', 'string', [
          'string',
          'number',
          'number',
          'number',
          'number',
          'number',
          'number',
          'number',
          'number',
        ])
      )
      .then((parse) => {
        readyParser = parse as ParseFn;
        return parse;
      })
      .catch((error) => {
        parserPromise = null;
        throw error;
      }) as Promise<ParseFn>;
  }
  return parserPromise;
}

function isASTNode(value: unknown): value is ASTNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as ASTNode).type === 'string'
  );
}

export function parseMarkdownSync(
  markdown: string,
  {
    underline = false,
    latexMath = true,
    superscript = false,
    subscript = false,
    highlight = false,
    hardSoftBreaks = false,
    preserveBlankLines = false,
    admonitions = true,
  }: Md4cFlags = {}
): ASTNode | null {
  const parse = readyParser;
  if (!parse) return null;

  const result: unknown = JSON.parse(
    parse(
      markdown,
      underline ? 1 : 0,
      latexMath ? 1 : 0,
      superscript ? 1 : 0,
      subscript ? 1 : 0,
      highlight ? 1 : 0,
      hardSoftBreaks ? 1 : 0,
      preserveBlankLines ? 1 : 0,
      admonitions ? 1 : 0
    )
  );

  if (!isASTNode(result)) {
    throw new Error('WASM parser returned invalid AST');
  }

  return result;
}

export async function parseMarkdown(
  markdown: string,
  flags: Md4cFlags = {}
): Promise<ASTNode> {
  await initializeParser();
  return parseMarkdownSync(markdown, flags)!;
}
