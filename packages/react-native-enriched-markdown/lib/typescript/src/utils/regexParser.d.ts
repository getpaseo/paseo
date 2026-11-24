import type { LinkNativeRegex } from '../EnrichedMarkdownTextInputNativeComponent';
import type { LinkRecognition } from '../types/MarkdownTextProps';
export declare const toNativeRegexConfig: (regex: RegExp | undefined | null) => LinkNativeRegex;
/** Renderer recognition is opt-in, including when input normalization falls back. */
export declare const toNativeTextLinkRegexConfig: (regex: RegExp | undefined) => LinkNativeRegex;
export interface LinkRecognitionNative {
    text: LinkNativeRegex;
    inlineCode: LinkNativeRegex;
}
export declare const toNativeLinkRecognition: (config: LinkRecognition | undefined) => LinkRecognitionNative;
export declare const isLinkRecognitionEqual: (previous: LinkRecognitionNative | undefined, next: LinkRecognitionNative) => boolean;
//# sourceMappingURL=regexParser.d.ts.map