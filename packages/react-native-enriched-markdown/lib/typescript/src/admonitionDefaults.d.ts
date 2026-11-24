import type { AdmonitionsStyle } from './types/MarkdownStyle';
export declare const ADMONITION_TYPES: readonly ["note", "tip", "important", "warning", "caution"];
export type AdmonitionType = (typeof ADMONITION_TYPES)[number];
export interface ResolvedAdmonitionColors {
    color: string;
    backgroundColor: string;
}
export type ResolvedAdmonitions = Record<AdmonitionType, ResolvedAdmonitionColors>;
export declare function resolveAdmonitionColors(user: AdmonitionsStyle | undefined): ResolvedAdmonitions;
//# sourceMappingURL=admonitionDefaults.d.ts.map