import { type ColorValue } from 'react-native';
import type { MarkdownStyle } from './types/MarkdownStyle';
export declare const normalizeColor: (color: string | undefined) => ColorValue | undefined;
export declare function mergeSubStyle<T extends Record<string, unknown>>(defaultStyle: T, userStyle?: Partial<T>): T;
export declare function isStyleEqual(a: MarkdownStyle, b: MarkdownStyle, referenceKeys: readonly string[]): boolean;
//# sourceMappingURL=styleUtils.d.ts.map