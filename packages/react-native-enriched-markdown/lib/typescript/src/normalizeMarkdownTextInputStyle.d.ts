import { type ColorValue } from 'react-native';
import type { MarkdownTextInputStyle } from './EnrichedMarkdownTextInput';
interface LinkVariantEntryInternal {
    pattern: string;
    color: ColorValue;
    underline: boolean;
    backgroundColor: ColorValue;
}
interface HeadingStyleInternal {
    fontSize: number;
    fontWeight: string;
    color: ColorValue;
}
interface MarkdownTextInputStyleInternal {
    strong: {
        color?: ColorValue;
    };
    em: {
        color?: ColorValue;
    };
    link: {
        color: ColorValue;
        underline: boolean;
        backgroundColor: ColorValue;
    };
    linkVariants: LinkVariantEntryInternal[];
    spoiler: {
        color: ColorValue;
        backgroundColor: ColorValue;
    };
    h1: HeadingStyleInternal;
    h2: HeadingStyleInternal;
    h3: HeadingStyleInternal;
    h4: HeadingStyleInternal;
    h5: HeadingStyleInternal;
    h6: HeadingStyleInternal;
    list: {
        itemSpacing: number;
    };
}
export declare const normalizeMarkdownTextInputStyle: (style?: MarkdownTextInputStyle) => MarkdownTextInputStyleInternal;
export {};
//# sourceMappingURL=normalizeMarkdownTextInputStyle.d.ts.map