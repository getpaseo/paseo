import type { LinkVariantStyle } from './types/MarkdownStyle';
import type { LinkPillContent } from './types/MarkdownTextProps';
type LinkPatternEntry<T> = [pattern: string, value: T];
/**
 * Orders URL patterns the way native tries them: longest first, so the most
 * specific pattern wins. Patterns that are not valid regexes are dropped.
 * `owner` names the prop in warnings.
 */
export declare function normalizeLinkPatternEntries<T>(entries: Record<string, T> | undefined, owner: string): LinkPatternEntry<T>[];
export declare function normalizeLinkVariantEntries(linkVariants?: Record<string, LinkVariantStyle>): LinkPatternEntry<LinkVariantStyle>[];
/** Native pill geometry is finite and nonnegative before crossing codegen. */
export declare function normalizeLinkPillStyle(style: LinkVariantStyle): {
    enabled: boolean;
    borderColor: string;
    label: string;
    iconUri: string;
    iconTintColor: string | undefined;
    borderRadius: number;
    paddingHorizontal: number;
    paddingVertical: number;
    lineHeight: number;
    borderWidth: number;
    maxWidth: number;
};
/** Flattens `linkPillContent` for native; sorted so equal maps produce the same array. */
export declare function normalizeLinkPillContent(content: Record<string, LinkPillContent> | undefined): {
    url: string;
    label: string;
    iconUri: string;
    iconTintColor: import("react-native/types_generated/Libraries/StyleSheet/StyleSheetTypes").____ColorValue_Internal | undefined;
}[] | undefined;
type NativeLinkPillContent = ReturnType<typeof normalizeLinkPillContent>;
/** Whether two flattened `linkPillContent` arrays hold the same entries. */
export declare function isLinkPillContentEqual(a: NativeLinkPillContent, b: NativeLinkPillContent): boolean;
export {};
//# sourceMappingURL=linkVariantUtils.d.ts.map