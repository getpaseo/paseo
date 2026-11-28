import type { MarkdownStyle, Md4cFlags } from '../types/MarkdownStyle';
import type { EnrichedMarkdownTextProps, StreamingConfig, ContextMenuItem, SelectionMenuConfig, SelectionMenuPluralLabels } from '../types/MarkdownTextProps';
import type { LinkPressEvent, LinkLongPressEvent, ImagePressEvent, TaskListItemPressEvent, CopyPressEvent, LatexErrorEvent, CodeBlockPressEvent } from '../types/events';
export type { MarkdownStyle, Md4cFlags };
export type { EnrichedMarkdownTextProps, StreamingConfig, ContextMenuItem, SelectionMenuConfig, SelectionMenuPluralLabels, };
export type { LinkPressEvent, LinkLongPressEvent, ImagePressEvent, TaskListItemPressEvent, CopyPressEvent, LatexErrorEvent, CodeBlockPressEvent, };
export declare const EnrichedMarkdownText: ({ markdown, markdownStyle, containerStyle, onLinkPress, onLinkLongPress, onImagePress, onTaskListItemPress, enableTaskListItemToggle, onCopyPress, onLatexError, onCodeBlockPress, enableBlockContextMenu, enableLinkPreview, selectable, md4cFlags, allowFontScaling, maxFontSizeMultiplier, allowTrailingMargin, flavor, streamingAnimation, streamingConfig, spoilerOverlay, contextMenuItems, linkContextMenuItems, imageRequestHeaders, linkPillContent, linkRecognition, selectionMenuConfig, accessibilityLabels, selectionColor, selectionHandleColor, textBreakStrategy, lineBreakStrategyIOS, writingDirection, numberOfLines, ellipsizeMode, renderers: _renderers, ...rest }: EnrichedMarkdownTextProps) => import("react/jsx-runtime").JSX.Element;
export default EnrichedMarkdownText;
//# sourceMappingURL=EnrichedMarkdownText.d.ts.map