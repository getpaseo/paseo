import type { ASTNode } from './types';

/**
 * Web counterpart of the native TextLinkRecognizer: turns regex matches in plain
 * text, and whole inline-code spans, into Link nodes marked `recognizedLink`.
 * Existing links, code blocks, media and math stay opaque.
 */

const OPAQUE: ReadonlySet<string> = new Set([
  'Link',
  'CodeBlock',
  'Image',
  'Video',
  'LatexMathInline',
  'LatexMathDisplay',
]);

function flagsOf(regex: RegExp, extra: string): string {
  let flags = extra;
  if (regex.ignoreCase) flags += 'i';
  if (regex.dotAll) flags += 's';
  return flags;
}

function compile(regex: RegExp | undefined, wholeSpan: boolean) {
  if (!regex || regex.source.length === 0) return null;
  try {
    return wholeSpan
      ? new RegExp(`^(?:${regex.source})$`, flagsOf(regex, ''))
      : new RegExp(regex.source, flagsOf(regex, 'g'));
  } catch {
    return null;
  }
}

function recognizedLink(child: ASTNode, url: string): ASTNode {
  return {
    type: 'Link',
    attributes: { url, recognizedLink: 'true' },
    children: [child],
  };
}

function transform(
  node: ASTNode,
  textRegex: RegExp | null,
  codeRegex: RegExp | null
): ASTNode[] {
  if (OPAQUE.has(node.type)) return [node];

  if (node.type === 'Code') {
    const content = (node.children ?? []).map((c) => c.content ?? '').join('');
    if (content.length > 0 && codeRegex && codeRegex.test(content)) {
      return [recognizedLink(node, content)];
    }
    return [node];
  }

  if (node.type === 'Text') {
    if (!textRegex) return [node];
    const content = node.content ?? '';
    const result: ASTNode[] = [];
    let offset = 0;
    textRegex.lastIndex = 0;
    for (const match of content.matchAll(textRegex)) {
      const start = match.index ?? 0;
      const matched = match[0];
      if (matched.length === 0) continue;
      if (start > offset) {
        result.push({ ...node, content: content.slice(offset, start) });
      }
      result.push(recognizedLink({ ...node, content: matched }, matched));
      offset = start + matched.length;
    }
    if (offset === 0) return [node];
    if (offset < content.length) {
      result.push({ ...node, content: content.slice(offset) });
    }
    return result;
  }

  if (!node.children || node.children.length === 0) return [node];
  const children = transformChildren(node.children, textRegex, codeRegex);
  return [children === node.children ? node : { ...node, children }];
}

// Returns the same array when no child changed, so untouched subtrees are not copied.
function transformChildren(
  children: ASTNode[],
  textRegex: RegExp | null,
  codeRegex: RegExp | null
): ASTNode[] {
  let result: ASTNode[] | null = null;
  children.forEach((child, index) => {
    const transformed = transform(child, textRegex, codeRegex);
    const unchanged = transformed.length === 1 && transformed[0] === child;
    if (result === null) {
      if (unchanged) return;
      result = children.slice(0, index);
    }
    result.push(...transformed);
  });
  return result ?? children;
}

export function recognizeTextLinks(
  ast: ASTNode,
  textLinkRegex: RegExp | undefined,
  inlineCodeLinkRegex: RegExp | undefined
): ASTNode {
  const textRegex = compile(textLinkRegex, false);
  const codeRegex = compile(inlineCodeLinkRegex, true);
  if (!textRegex && !codeRegex) return ast;
  return transform(ast, textRegex, codeRegex)[0] ?? ast;
}
