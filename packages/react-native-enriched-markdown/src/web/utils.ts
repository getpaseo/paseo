import type { ASTNode } from './types';

/** Recursively collects plain text content from an AST node's subtree. */
export function extractNodeText(node: ASTNode): string {
  if (node.type === 'SoftBreak' || node.type === 'LineBreak') return ' ';
  if (node.content !== undefined) return node.content;
  return node.children?.map(extractNodeText).join('') ?? '';
}

/** Extracts the filename from a URL path, without extension. */
export function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url, 'https://placeholder').pathname;
    const filename = pathname.split('/').pop() ?? '';
    return filename.replace(/\.[^.]+$/, '');
  } catch {
    return '';
  }
}

/**
 * Stamps each task ListItem with a sequential `taskIndex` matching the order
 * native C++ assigns — so onTaskListItemPress.index is correct on web too.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export function indexTaskItems(node: ASTNode, counter = { value: 0 }): void {
  if (node.type === 'ListItem' && node.attributes?.isTask === 'true') {
    node.attributes.taskIndex = counter.value++;
  }
  node.children?.forEach((child) => indexTaskItems(child, counter));
}

/**
 * Stamps Image nodes with `isInline` when they appear inside a paragraph
 * that also contains other content (text, links, etc.).
 * Matches native behavior: sole-child images are block-level, mixed are inline.
 * A link wrapping only an image counts as an image, so `[![badge](x)](y) text`
 * stamps the nested image inline while a lone `[![x](y)](z)` stays a block.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export function markInlineImages(node: ASTNode): void {
  if (node.type === 'Paragraph' && node.children) {
    if (!node.children.every(isImageLike)) {
      node.children.forEach(stampInlineImages);
    }
  }
  node.children?.forEach(markInlineImages);
}

function isImageLike(node: ASTNode): boolean {
  if (node.type === 'Image') return true;
  return (
    node.type === 'Link' &&
    node.children?.length === 1 &&
    isImageLike(node.children[0]!)
  );
}

function stampInlineImages(node: ASTNode): void {
  if (node.type === 'Image') {
    node.attributes = { ...node.attributes, isInline: true };
    return;
  }
  node.children?.forEach(stampInlineImages);
}
