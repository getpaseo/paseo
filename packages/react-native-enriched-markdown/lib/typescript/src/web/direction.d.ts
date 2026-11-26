import type { ASTNode } from './types';
export type TextDirection = 'ltr' | 'rtl';
export declare function hasRtlCharacters(text: string): boolean;
export declare function isTechnicalLink(node: ASTNode): boolean;
export declare function resolveNodeDirection(node: ASTNode): TextDirection | undefined;
