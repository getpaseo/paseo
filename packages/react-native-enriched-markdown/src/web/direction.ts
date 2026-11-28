import type { ASTNode } from './types';

export type TextDirection = 'ltr' | 'rtl';

// Strong RTL letters in the BMP (Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan,
// Mandaic, and their presentation forms); digits and combining marks are excluded.
const RTL_LETTER_RE =
  /[\u0590-\u05FF\u0620-\u064A\u066E-\u066F\u0671-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const WORD_RE = /\p{L}+/gu;

export function hasRtlCharacters(text: string): boolean {
  return RTL_LETTER_RE.test(text);
}

export function isTechnicalLink(node: ASTNode): boolean {
  if (node.type !== 'Link') return false;
  if (node.attributes?.recognizedLink === 'true') return true;
  const url = node.attributes?.url;
  if (!url) return false;
  const label = collectRawText(node).trim();
  return label === url;
}

function collectRawText(node: ASTNode): string {
  if (node.content !== undefined) return node.content;
  return node.children?.map(collectRawText).join('') ?? '';
}

function isBoundaryNode(type: ASTNode['type']): boolean {
  return (
    type === 'Paragraph' ||
    type === 'Heading' ||
    type === 'ListItem' ||
    type === 'TableHeaderCell' ||
    type === 'TableCell' ||
    type === 'Blockquote' ||
    type === 'Admonition'
  );
}

function collectProseText(node: ASTNode, chunks: string[]): void {
  switch (node.type) {
    case 'Code':
    case 'CodeBlock':
    case 'LatexMathInline':
    case 'LatexMathDisplay':
    case 'Image':
    case 'Video':
    case 'SoftBreak':
    case 'LineBreak':
      chunks.push(' ');
      return;
    case 'Link':
      if (isTechnicalLink(node)) {
        chunks.push(' ');
        return;
      }
      break;
    default:
      break;
  }

  if (node.content !== undefined) {
    chunks.push(node.content);
    return;
  }

  if (!node.children) return;
  for (const child of node.children) {
    collectProseText(child, chunks);
  }
  if (isBoundaryNode(node.type)) {
    chunks.push(' ');
  }
}

/**
 * Resolves a block's base direction from its prose text, skipping inline code,
 * code blocks, math, and technical links.
 *
 * Follows first-strong when prose begins with RTL; when prose begins with an
 * LTR term (e.g. a technical identifier) followed by predominantly RTL words,
 * resolves to RTL so mixed-script sentences keep natural reading order.
 * Returns undefined for neutral-only content so it inherits from its container.
 */
export function resolveNodeDirection(node: ASTNode): TextDirection | undefined {
  const chunks: string[] = [];
  collectProseText(node, chunks);
  const prose = chunks.join('');

  if (!RTL_LETTER_RE.test(prose)) {
    WORD_RE.lastIndex = 0;
    return WORD_RE.test(prose) ? 'ltr' : undefined;
  }

  let firstWordChecked = false;
  let rtlWords = 0;
  let ltrWords = 0;

  WORD_RE.lastIndex = 0;
  let match = WORD_RE.exec(prose);
  while (match !== null) {
    const isRtlWord = RTL_LETTER_RE.test(match[0]);
    if (!firstWordChecked) {
      firstWordChecked = true;
      if (isRtlWord) return 'rtl';
    }
    if (isRtlWord) {
      rtlWords += 1;
    } else {
      ltrWords += 1;
    }
    match = WORD_RE.exec(prose);
  }

  return rtlWords > ltrWords ? 'rtl' : 'ltr';
}
