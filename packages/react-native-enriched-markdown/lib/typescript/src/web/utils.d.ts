import type { ASTNode } from './types';
/** Recursively collects plain text content from an AST node's subtree. */
export declare function extractNodeText(node: ASTNode): string;
/** Extracts the filename from a URL path, without extension. */
export declare function filenameFromUrl(url: string): string;
/**
 * Stamps each task ListItem with a sequential `taskIndex` matching the order
 * native C++ assigns — so onTaskListItemPress.index is correct on web too.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export declare function indexTaskItems(node: ASTNode, counter?: {
    value: number;
}): void;
/**
 * Stamps Image nodes with `isInline` when they appear inside a paragraph
 * that also contains other content (text, links, etc.).
 * Matches native behavior: sole-child images are block-level, mixed are inline.
 * Mutates the AST in-place (safe: called once on the freshly-parsed result).
 */
export declare function markInlineImages(node: ASTNode): void;
//# sourceMappingURL=utils.d.ts.map