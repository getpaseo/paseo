import { useMemo, useCallback, useRef, useEffect } from 'react';
import EnrichedMarkdownTextNativeComponent from '../EnrichedMarkdownTextNativeComponent';
import type { MarkdownStyleInternal } from '../EnrichedMarkdownTextNativeComponent';
import EnrichedMarkdownNativeComponent from '../EnrichedMarkdownNativeComponent';
import {
  isLinkRecognitionEqual,
  toNativeLinkRecognition,
  type LinkRecognitionNative,
} from '../utils/regexParser';
import { normalizeMarkdownStyle } from '../normalizeMarkdownStyle';
import {
  isLinkPillContentEqual,
  normalizeLinkPillContent,
} from '../linkVariantUtils';
import {
  dispatchLinkContextMenuItem,
  isLinkContextMenuItemsEqual,
  normalizeLinkContextMenuItems,
} from '../linkContextMenuUtils';
import { resolveAccessibilityLabels } from '../accessibilityLabelDefaults';
import {
  normalizeMenuItem,
  normalizeLegacyBooleanMenuItem,
} from '../normalizeMenuItem';
import type { NativeSyntheticEvent } from 'react-native';
import type { MarkdownStyle, Md4cFlags } from '../types/MarkdownStyle';
import type {
  EnrichedMarkdownTextProps,
  StreamingConfig,
  ContextMenuItem,
  SelectionMenuConfig,
  SelectionMenuPluralLabels,
} from '../types/MarkdownTextProps';
import type {
  LinkPressEvent,
  LinkLongPressEvent,
  ImagePressEvent,
  TaskListItemPressEvent,
  CopyPressEvent,
  LatexErrorEvent,
  CodeBlockPressEvent,
  OnContextMenuItemPressEvent,
  OnLinkContextMenuItemPressEvent,
} from '../types/events';

export type { MarkdownStyle, Md4cFlags };
export type {
  EnrichedMarkdownTextProps,
  StreamingConfig,
  ContextMenuItem,
  SelectionMenuConfig,
  SelectionMenuPluralLabels,
};
export type {
  LinkPressEvent,
  LinkLongPressEvent,
  ImagePressEvent,
  TaskListItemPressEvent,
  CopyPressEvent,
  LatexErrorEvent,
  CodeBlockPressEvent,
};

// Default English labels for the built-in selection menu actions. Defaults are
// resolved here (JS-side) so the native code always receives a concrete string.
const DEFAULT_COPY_LABEL = 'Copy';
const DEFAULT_COPY_AS_MARKDOWN_LABEL = 'Copy as Markdown';
const DEFAULT_COPY_IMAGE_URL_LABEL = 'Copy Image URL';
const DEFAULT_COPY_IMAGE_URLS_LABEL = 'Copy {count} Image URLs';

/**
 * Resolves `pluralLabels` into a per-count template table (index = image count,
 * 0..100) the native side can index without any locale logic. `Intl.PluralRules`
 * selects the CLDR category for each count; missing categories fall back to the
 * required `other`. Index 1 uses the singular `label` (the single-image case).
 * Native uses `other` (copyImageUrlsLabel) for counts > 100, and falls back to
 * the singular/`{count}` templates entirely when this returns an empty array
 * (no plural labels set, or `Intl.PluralRules` unavailable).
 */
const buildPluralTemplates = (
  pluralLabels: SelectionMenuPluralLabels | undefined,
  singularLabel: string
): string[] => {
  if (!pluralLabels) return [];

  const IntlRef = Intl as unknown as {
    PluralRules?: new (locales?: string | string[]) => {
      select(n: number): string;
    };
  };
  if (typeof IntlRef.PluralRules !== 'function') return [];

  let pluralRules: { select(n: number): string };
  try {
    // TODO: expose `copyImageUrl.pluralLocale?: string` so i18n apps can force
    // a locale independent of the device. Today this resolves to the JS
    // runtime's default locale, so on an English device only `one` and `other`
    // ever fire even when richer plural labels are configured.
    pluralRules = new IntlRef.PluralRules();
  } catch {
    return [];
  }

  const { other } = pluralLabels;
  const byCategory: Record<string, string> = {
    zero: pluralLabels.zero ?? other,
    one: pluralLabels.one ?? other,
    two: pluralLabels.two ?? other,
    few: pluralLabels.few ?? other,
    many: pluralLabels.many ?? other,
    other,
  };

  const templates: string[] = [];
  for (let n = 0; n <= 100; n++) {
    // The literal single-image case uses the (non-plural) singular label; every
    // other count uses its CLDR category form.
    templates.push(
      n === 1 ? singularLabel : (byCategory[pluralRules.select(n)] ?? other)
    );
  }
  return templates;
};

const defaultMd4cFlags: Md4cFlags = {
  underline: false,
  superscript: false,
  subscript: false,
  latexMath: true,
  highlight: false,
  hardSoftBreaks: false,
  preserveBlankLines: false,
  admonitions: true,
};

export const EnrichedMarkdownText = ({
  markdown,
  markdownStyle = {},
  containerStyle,
  onLinkPress,
  onLinkLongPress,
  onImagePress,
  onTaskListItemPress,
  enableTaskListItemToggle = true,
  onCopyPress,
  onLatexError,
  onCodeBlockPress,
  enableBlockContextMenu = true,
  enableLinkPreview,
  selectable = true,
  md4cFlags = defaultMd4cFlags,
  allowFontScaling = true,
  maxFontSizeMultiplier,
  allowTrailingMargin = false,
  flavor = 'commonmark',
  streamingAnimation = false,
  streamingConfig,
  spoilerOverlay = 'particles',
  contextMenuItems,
  linkContextMenuItems,
  imageRequestHeaders,
  linkPillContent,
  linkRecognition,
  selectionMenuConfig,
  accessibilityLabels,
  selectionColor,
  selectionHandleColor,
  textBreakStrategy,
  lineBreakStrategyIOS,
  writingDirection = 'first-strong',
  numberOfLines,
  ellipsizeMode,
  renderers: _renderers,
  ...rest
}: EnrichedMarkdownTextProps) => {
  // An equal config keeps the previous object, so an inline literal does not
  // re-send the prop on every render.
  const linkRecognitionRef = useRef<LinkRecognitionNative | undefined>(
    undefined
  );
  const nativeLinkRecognition = useMemo(() => {
    const next = toNativeLinkRecognition(linkRecognition);
    if (!isLinkRecognitionEqual(linkRecognitionRef.current, next)) {
      linkRecognitionRef.current = next;
    }
    return linkRecognitionRef.current!;
  }, [linkRecognition]);
  const normalizedStyleRef = useRef<MarkdownStyleInternal | null>(null);
  const normalized = normalizeMarkdownStyle(markdownStyle);
  // normalizeMarkdownStyle returns cached objects for structurally equal inputs,
  // so this referential check is sufficient to preserve a stable prop reference.
  if (normalizedStyleRef.current !== normalized) {
    normalizedStyleRef.current = normalized;
  }
  const normalizedStyle = normalizedStyleRef.current!;

  const normalizedMd4cFlags = useMemo(
    () => ({
      underline: md4cFlags.underline ?? false,
      superscript: md4cFlags.superscript ?? false,
      subscript: md4cFlags.subscript ?? false,
      latexMath: md4cFlags.latexMath ?? true,
      highlight: md4cFlags.highlight ?? false,
      hardSoftBreaks: md4cFlags.hardSoftBreaks ?? false,
      preserveBlankLines: md4cFlags.preserveBlankLines ?? false,
      // Admonitions are a GitHub-flavor feature; force them off in commonmark so
      // `> [!NOTE]` renders as a plain blockquote.
      admonitions:
        flavor === 'github' ? (md4cFlags.admonitions ?? true) : false,
    }),
    [md4cFlags, flavor]
  );

  const contextMenuCallbacksRef = useRef<
    Map<string, ContextMenuItem['onPress']>
  >(new Map());

  useEffect(() => {
    const callbacksMap = new Map<string, ContextMenuItem['onPress']>();
    if (contextMenuItems) {
      for (const item of contextMenuItems) {
        callbacksMap.set(item.text, item.onPress);
      }
    }
    contextMenuCallbacksRef.current = callbacksMap;
  }, [contextMenuItems]);

  const nativeContextMenuItems = useMemo(
    () =>
      contextMenuItems
        ?.filter((item) => item.visible !== false)
        .map((item) => ({ text: item.text, icon: item.icon })),
    [contextMenuItems]
  );

  const linkContextMenuItemsRef = useRef(linkContextMenuItems);
  linkContextMenuItemsRef.current = linkContextMenuItems;
  // Callbacks change on most renders; native only needs to hear about the menus
  // when what they show changes.
  const nativeLinkContextMenuItemsRef = useRef<
    ReturnType<typeof normalizeLinkContextMenuItems>
  >([]);
  const nativeLinkContextMenuItems = useMemo(() => {
    const next = normalizeLinkContextMenuItems(linkContextMenuItems);
    if (
      !isLinkContextMenuItemsEqual(nativeLinkContextMenuItemsRef.current, next)
    ) {
      nativeLinkContextMenuItemsRef.current = next;
    }
    return nativeLinkContextMenuItemsRef.current;
  }, [linkContextMenuItems]);
  const handleLinkContextMenuItemPress = useCallback(
    (event: NativeSyntheticEvent<OnLinkContextMenuItemPressEvent>) => {
      const { url, pattern, itemText } = event.nativeEvent;
      dispatchLinkContextMenuItem(
        linkContextMenuItemsRef.current,
        pattern,
        itemText,
        url
      );
    },
    []
  );

  const nativeImageRequestHeaders = useMemo(
    () =>
      imageRequestHeaders
        ? Object.entries(imageRequestHeaders)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        : undefined,
    [imageRequestHeaders]
  );

  // An equal map keeps the previous array, so passing the prop inline does not
  // re-send it to native on every render.
  const linkPillContentRef =
    useRef<ReturnType<typeof normalizeLinkPillContent>>(undefined);
  const nativeLinkPillContent = useMemo(() => {
    const next = normalizeLinkPillContent(linkPillContent);
    if (!isLinkPillContentEqual(linkPillContentRef.current, next)) {
      linkPillContentRef.current = next;
    }
    return linkPillContentRef.current;
  }, [linkPillContent]);

  const handleContextMenuItemPress = useCallback(
    (e: NativeSyntheticEvent<OnContextMenuItemPressEvent>) => {
      const { itemText, selectedText, selectionStart, selectionEnd } =
        e.nativeEvent;
      const callback = contextMenuCallbacksRef.current.get(itemText);
      callback?.({
        text: selectedText,
        selection: { start: selectionStart, end: selectionEnd },
      });
    },
    []
  );

  const handleLinkPress = useCallback(
    (e: NativeSyntheticEvent<{ url: string; sourceType: string }>) => {
      const { url, sourceType } = e.nativeEvent;
      onLinkPress?.({
        url,
        sourceType: sourceType as LinkPressEvent['sourceType'],
      });
    },
    [onLinkPress]
  );

  const handleLinkLongPress = useCallback(
    (e: NativeSyntheticEvent<LinkLongPressEvent>) => {
      const { url } = e.nativeEvent;
      onLinkLongPress?.({ url });
    },
    [onLinkLongPress]
  );

  const handleImagePress = useCallback(
    (e: NativeSyntheticEvent<ImagePressEvent>) => {
      const { url, altText } = e.nativeEvent;
      onImagePress?.({ url, altText });
    },
    [onImagePress]
  );

  const handleTaskListItemPress = useCallback(
    (e: NativeSyntheticEvent<TaskListItemPressEvent>) => {
      const { index, checked, text } = e.nativeEvent;
      onTaskListItemPress?.({ index, checked, text });
    },
    [onTaskListItemPress]
  );

  const handleCopyPress = useCallback(
    (e: NativeSyntheticEvent<CopyPressEvent>) => {
      const { code, language } = e.nativeEvent;
      onCopyPress?.({ code, language });
    },
    [onCopyPress]
  );

  const handleLatexError = useCallback(
    (e: NativeSyntheticEvent<LatexErrorEvent>) => {
      const { source, message, displayMode } = e.nativeEvent;
      onLatexError?.({ source, message: message || undefined, displayMode });
    },
    [onLatexError]
  );

  const handleCodeBlockPress = useCallback(
    (e: NativeSyntheticEvent<CodeBlockPressEvent>) => {
      const { code, language } = e.nativeEvent;
      onCodeBlockPress?.({ code, language });
    },
    [onCodeBlockPress]
  );

  const tableMode = streamingConfig?.tableMode ?? 'progressive';
  const codeBlockMode = streamingConfig?.codeBlockMode ?? 'progressive';
  const normalizedStreamingConfig = useMemo(
    () => ({ tableMode, codeBlockMode }),
    [tableMode, codeBlockMode]
  );
  const normalizedSelectionMenuConfig = useMemo(() => {
    // The boolean acceptance is confined to this wrapper boundary via a single
    // `as unknown` cast; the public type only exposes the object shape.
    const config = selectionMenuConfig as
      | {
          copy?: unknown;
          copyAsMarkdown?: unknown;
          copyImageUrl?: unknown;
        }
      | undefined;

    const copy = normalizeMenuItem(config?.copy, true, DEFAULT_COPY_LABEL);
    const copyAsMarkdown = normalizeLegacyBooleanMenuItem(
      config?.copyAsMarkdown,
      'selectionMenuConfig',
      'copyAsMarkdown',
      true,
      DEFAULT_COPY_AS_MARKDOWN_LABEL
    );
    const copyImageUrl = normalizeLegacyBooleanMenuItem(
      config?.copyImageUrl,
      'selectionMenuConfig',
      'copyImageUrl',
      true,
      DEFAULT_COPY_IMAGE_URL_LABEL
    );

    const pluralLabels = (
      config?.copyImageUrl as
        | { pluralLabels?: SelectionMenuPluralLabels }
        | undefined
    )?.pluralLabels;

    return {
      copyAsMarkdown: copyAsMarkdown.enabled,
      copyImageUrl: copyImageUrl.enabled,
      copyLabel: copy.label,
      copyAsMarkdownLabel: copyAsMarkdown.label,
      copyImageUrlLabel: copyImageUrl.label,
      copyImageUrlsLabel: pluralLabels?.other ?? DEFAULT_COPY_IMAGE_URLS_LABEL,
      copyImageUrlPluralTemplates: buildPluralTemplates(
        pluralLabels,
        copyImageUrl.label
      ),
    };
  }, [selectionMenuConfig]);

  const resolvedAccessibilityLabels = useMemo(
    () => resolveAccessibilityLabels(accessibilityLabels),
    [accessibilityLabels]
  );

  const sharedProps = {
    markdown,
    linkRecognition: nativeLinkRecognition,
    markdownStyle: normalizedStyle,
    onLinkPress: handleLinkPress,
    onLinkLongPress: handleLinkLongPress,
    onImagePress: handleImagePress,
    enableImagePress: onImagePress != null,
    onTaskListItemPress: handleTaskListItemPress,
    enableTaskListItemToggle,
    onCopyPress: handleCopyPress,
    onLatexError: handleLatexError,
    onCodeBlockPress: handleCodeBlockPress,
    enableCodeBlockPress: onCodeBlockPress != null,
    enableBlockContextMenu,
    enableLinkPreview: onLinkLongPress == null && (enableLinkPreview ?? true),
    selectable,
    md4cFlags: normalizedMd4cFlags,
    isGFM: flavor === 'github',
    allowFontScaling,
    maxFontSizeMultiplier,
    allowTrailingMargin,
    streamingAnimation,
    streamingConfig: normalizedStreamingConfig,
    spoilerOverlay,
    style: containerStyle,
    contextMenuItems: nativeContextMenuItems,
    linkContextMenuItems: nativeLinkContextMenuItems,
    onLinkContextMenuItemPress: handleLinkContextMenuItemPress,
    imageRequestHeaders: nativeImageRequestHeaders,
    linkPillContent: nativeLinkPillContent,
    selectionMenuConfig: normalizedSelectionMenuConfig,
    accessibilityLabels: resolvedAccessibilityLabels,
    onContextMenuItemPress: handleContextMenuItemPress,
    selectionColor,
    selectionHandleColor,
    textBreakStrategy,
    lineBreakStrategyIOS,
    writingDirection,
    numberOfLines,
    ellipsizeMode,
    ...rest,
  };

  if (flavor === 'github') {
    return <EnrichedMarkdownNativeComponent {...sharedProps} />;
  }

  return <EnrichedMarkdownTextNativeComponent {...sharedProps} />;
};

export default EnrichedMarkdownText;
