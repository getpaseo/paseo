import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type React from 'react';
import EnrichedMarkdownTextInputNativeComponent, {
  Commands,
  type NativeProps,
  type OnChangeTextEvent,
  type OnChangeMarkdownEvent,
  type OnChangeSelectionEvent,
  type OnChangeStateEvent,
  type OnKeyPressEvent,
  type OnRequestMarkdownResultEvent,
  type OnRequestCaretRectResultEvent,
  type OnCaretRectChangeEvent,
  type OnContextMenuItemPressEvent,
  type OnLinkDetected,
  type OnStartMentionEvent,
  type OnChangeMentionEvent,
  type OnEndMentionEvent,
} from './EnrichedMarkdownTextInputNativeComponent';
export type {
  OnKeyPressEvent,
  OnLinkDetected,
  OnStartMentionEvent,
  OnChangeMentionEvent,
  OnEndMentionEvent,
} from './EnrichedMarkdownTextInputNativeComponent';
import type {
  GestureResponderEvent,
  HostInstance,
  NativeSyntheticEvent,
  TextInputProps,
  ViewProps,
  TextStyle,
  StyleProp,
  ColorValue,
} from 'react-native';
import { Platform } from 'react-native';
import { normalizeMarkdownShortcuts } from './normalizeMarkdownShortcuts';
import { normalizeMarkdownTextInputStyle } from './normalizeMarkdownTextInputStyle';
import { normalizeMenuItem } from './normalizeMenuItem';
import { toNativeRegexConfig } from './utils/regexParser';
import { TextInputState } from './utils/textInputState';
import { usePressability } from './utils/usePressability';
import type { RefObject } from 'react';

type NativeRef = HostInstance;

export interface LinkStyle {
  color?: string;
  underline?: boolean;
  backgroundColor?: string;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const VALID_HEADING_LEVELS = new Set<number>([1, 2, 3, 4, 5, 6]);

function toHeadingLevel(n: number): HeadingLevel {
  return (VALID_HEADING_LEVELS.has(n) ? n : 1) as HeadingLevel;
}

export interface HeadingStyle {
  fontSize?: number;
  fontWeight?: string;
  color?: string;
}

export interface MarkdownTextInputStyle {
  strong?: {
    color?: string;
  };
  em?: {
    color?: string;
  };
  link?: LinkStyle;
  linkVariants?: Record<string, LinkStyle>;
  spoiler?: {
    color?: string;
    backgroundColor?: string;
  };
  /**
   * Per-level heading styling for the editor, mirroring the readonly
   * renderer's `markdownStyle` h1..h6. Omitted levels fall back to defaults
   * (font sizes 30/24/20/18/16/14).
   */
  h1?: HeadingStyle;
  h2?: HeadingStyle;
  h3?: HeadingStyle;
  h4?: HeadingStyle;
  h5?: HeadingStyle;
  h6?: HeadingStyle;
  /** List styling shared by bullet and numbered lists. */
  list?: {
    /**
     * Vertical spacing (points) added above each list item so items read as
     * separate rows. iOS uses `paragraphSpacingBefore`; Android a `LineHeightSpan`.
     * @default 0
     */
    itemSpacing?: number;
  };
}

export interface StyleState {
  bold: { isActive: boolean };
  italic: { isActive: boolean };
  underline: { isActive: boolean };
  strikethrough: { isActive: boolean };
  spoiler: { isActive: boolean };
  /**
   * The link at the selection: the one containing the first selected
   * character, or, for a collapsed caret, the one the caret is inside or right
   * after. `setLink` and `removeLink` act on this same link. `destination` is
   * `""` when there is no link, and can also be `""` for a link with an empty
   * URL.
   */
  link: { isActive: boolean; destination: string };
  heading: { isActive: boolean; level: HeadingLevel };
  unorderedList: { isActive: boolean; depth: number };
  orderedList: { isActive: boolean; depth: number };
}

export interface ContextMenuItem {
  text: string;
  onPress: (event: {
    text: string;
    selection: { start: number; end: number };
    styleState: StyleState;
  }) => void;
  icon?: string;
  visible?: boolean;
}

export interface CaretRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EnrichedMarkdownTextInputInstance {
  focus: () => void;
  blur: () => void;
  measure: HostInstance['measure'];
  measureInWindow: HostInstance['measureInWindow'];
  measureLayout: HostInstance['measureLayout'];
  setValue: (markdown: string) => void;
  setSelection: (start: number, end: number) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrikethrough: () => void;
  toggleSpoiler: () => void;
  toggleHeading: (level: HeadingLevel) => void;
  toggleUnorderedList: () => void;
  toggleOrderedList: () => void;
  indentList: () => void;
  outdentList: () => void;
  setLink: (url: string) => void;
  insertLink: (text: string, url: string) => void;
  insertText: (text: string) => void;
  insertMention: (displayText: string, url: string) => void;
  startMention: (indicator: string) => void;
  removeLink: () => void;
  copyToClipboard: () => void;
  getMarkdown: () => Promise<string>;
  getCaretRect: () => Promise<CaretRect>;
}

/**
 * Per-item shape: `{ enabled }` toggles visibility, `label` overrides the
 * English default. Wire `label` to your i18n library to localize the menu.
 */
type MenuItem = { enabled?: boolean; label?: string };

export interface InputSelectionMenuConfig {
  /**
   * The built-in "Format" submenu (Bold, Italic, Underline, etc.) in the
   * text selection context menu. `label` overrides the submenu title.
   * @default { enabled: true, label: "Format" }
   */
  format?: MenuItem;
  /**
   * The built-in "Copy as Markdown" action in the text selection context
   * menu. `label` overrides the action title.
   * @default { enabled: true, label: "Copy as Markdown" }
   */
  copyAsMarkdown?: MenuItem;
}

/** Controls the individual items inside the Format submenu. */
export interface FormatMenuConfig {
  /** @default { enabled: true, label: "Bold" } */
  bold?: MenuItem;
  /** @default { enabled: true, label: "Italic" } */
  italic?: MenuItem;
  /** @default { enabled: true, label: "Underline" } */
  underline?: MenuItem;
  /** @default { enabled: true, label: "Strikethrough" } */
  strikethrough?: MenuItem;
  /** @default { enabled: true, label: "Spoiler" } */
  spoiler?: MenuItem;
  /** @default { enabled: true, label: "Link" } */
  link?: MenuItem;
}

/**
 * Which typed markdown block prefixes convert into blocks. An omitted key is
 * off, so `{ heading: true }` enables headings and nothing else.
 */
export interface MarkdownShortcutsConfig {
  /** `#`–`######` + space. @default false */
  heading?: boolean;
  /** `-`/`*`/`+` + space. @default false */
  unorderedList?: boolean;
  /** `1.` or `1)` + space. @default false */
  orderedList?: boolean;
}

export interface EnrichedMarkdownTextInputProps
  extends
    Omit<ViewProps, 'style' | 'children'>,
    // Same press props as React Native TextInput; `hitSlop` comes from ViewProps.
    Pick<
      TextInputProps,
      'onPress' | 'onPressIn' | 'onPressOut' | 'rejectResponderTermination'
    > {
  ref?: RefObject<EnrichedMarkdownTextInputInstance | null>;
  defaultValue?: string;
  placeholder?: string;
  placeholderTextColor?: ColorValue;
  editable?: boolean;
  autoFocus?: boolean;
  scrollEnabled?: boolean;
  /**
   * Converts markdown block prefixes typed at the start of a paragraph into
   * blocks, the way Notion, Bear and Obsidian do: `#`–`######` + space becomes
   * a heading, `-`/`*`/`+` + space a bullet item, `1.` (or `1)`) + space a
   * numbered item. The prefix and its space are removed from the text.
   * `true` enables all three; pass a {@link MarkdownShortcutsConfig} to enable
   * a subset. Off by default so apps that treat `#` or `-` as literal text
   * (tags, dashes) see no change.
   * @default false
   */
  markdownShortcuts?: boolean | MarkdownShortcutsConfig;
  autoCapitalize?: string;
  multiline?: boolean;
  cursorColor?: ColorValue;
  selectionColor?: ColorValue;
  markdownStyle?: MarkdownTextInputStyle;
  style?: StyleProp<TextStyle>;
  onChangeText?: (text: string) => void;
  onChangeMarkdown?: (markdown: string) => void;
  onChangeSelection?: (selection: { start: number; end: number }) => void;
  onChangeState?: (state: StyleState) => void;
  onKeyPress?: (e: NativeSyntheticEvent<OnKeyPressEvent>) => void;
  onCaretRectChange?: (rect: CaretRect) => void;
  onLinkDetected?: (event: OnLinkDetected) => void;
  mentionIndicators?: string[];
  onStartMention?: (event: OnStartMentionEvent) => void;
  onChangeMention?: (event: OnChangeMentionEvent) => void;
  onEndMention?: (event: OnEndMentionEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  contextMenuItems?: ContextMenuItem[];
  /**
   * Controls built-in items in the text selection context menu.
   * Omitting the prop or any field reproduces today's exact menu.
   * Custom app-provided actions are controlled separately via `contextMenuItems`.
   * @default { format: true, copyAsMarkdown: true }
   * @platform ios, android, macos
   */
  selectionMenuConfig?: InputSelectionMenuConfig;
  /**
   * Controls which items appear inside the Format submenu.
   * Only effective when `selectionMenuConfig.format` is `true` (the default).
   * Omitting the prop or any field shows all items.
   * @default { bold: true, italic: true, underline: true, strikethrough: true, spoiler: true, link: true }
   * @platform ios, android, macos
   */
  formatMenuConfig?: FormatMenuConfig;
  linkRegex?: RegExp | null;
  /**
   * Paragraph writing direction.
   * - `'first-strong'` (default): resolves each paragraph from its first strong
   *   directional character. Neutral-only paragraphs fall back to the view's
   *   resolved layout direction (inherits ancestor `direction` style). Library
   *   extension — matches Android's `TEXT_DIRECTION_FIRST_STRONG`.
   * - `'auto'`: React Native parity. iOS TextKit follows the app's
   *   `userInterfaceLayoutDirection`; mixed-direction paragraphs do not
   *   auto-resolve.
   * - `'ltr'` / `'rtl'`: force base direction on every paragraph.
   *
   * Android ignores this prop; the platform's `EditText` always uses
   * `TEXT_DIRECTION_FIRST_STRONG` per paragraph.
   * @default 'first-strong'
   * @platform ios
   */
  writingDirection?: 'auto' | 'ltr' | 'rtl' | 'first-strong';
}

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function getNativeRef(ref: React.RefObject<NativeRef | null>): NativeRef {
  if (ref.current == null) {
    throw new Error(
      'EnrichedMarkdownTextInput: native ref is not attached. Ensure the component is mounted.'
    );
  }
  return ref.current;
}

export const EnrichedMarkdownTextInput = ({
  ref,
  markdownStyle,
  style,
  defaultValue,
  placeholder,
  placeholderTextColor,
  editable = true,
  autoFocus = false,
  scrollEnabled = true,
  markdownShortcuts,
  autoCapitalize = 'sentences',
  multiline = true,
  cursorColor,
  selectionColor,
  onChangeText,
  onChangeMarkdown,
  onChangeSelection,
  onChangeState,
  onKeyPress,
  onCaretRectChange,
  onLinkDetected,
  mentionIndicators,
  onStartMention,
  onChangeMention,
  onEndMention,
  onFocus,
  onBlur,
  onPress,
  onPressIn,
  onPressOut,
  hitSlop,
  rejectResponderTermination = true,
  contextMenuItems,
  selectionMenuConfig,
  formatMenuConfig,
  linkRegex: _linkRegex,
  writingDirection = 'first-strong',
  ...rest
}: EnrichedMarkdownTextInputProps) => {
  const nativeRef = useRef<NativeRef | null>(null);
  // Freeze `defaultValue` at mount (RN TextInput semantics): post-mount changes are ignored.
  const initialDefaultValue = useRef(defaultValue).current;

  const nextRequestId = useRef(1);
  const pendingRequests = useRef(new Map<number, PendingRequest<string>>());
  const pendingCaretRectRequests = useRef(
    new Map<number, PendingRequest<CaretRect>>()
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

  useEffect(() => {
    const pending = pendingRequests.current;
    const pendingCaretRect = pendingCaretRectRequests.current;
    return () => {
      const err = new Error('Component unmounted');
      pending.forEach(({ reject }) => reject(err));
      pending.clear();
      pendingCaretRect.forEach(({ reject }) => reject(err));
      pendingCaretRect.clear();
    };
  }, []);

  /**
   * Mirrors the built-in TextInput's TextInputState integration so scroll
   * containers' keyboardShouldPersistTaps logic and Keyboard.dismiss treat
   * this input like a native TextInput. See utils/textInputState.ts for the
   * full rationale. The unmount cleanup blurs through blurTextInput so both
   * the registry entry and the native focus are released, matching the
   * TextInput unmount path.
   */
  useLayoutEffect(() => {
    const instance = nativeRef.current;
    if (instance == null) return;

    TextInputState.registerInput(instance);
    return () => {
      if (TextInputState.currentlyFocusedInput() === instance) {
        TextInputState.blurTextInput(instance);
      }
      TextInputState.unregisterInput(instance);
    };
  }, []);

  const normalizedStyle = normalizeMarkdownTextInputStyle(markdownStyle);

  const normalizedSelectionMenuConfig = useMemo(() => {
    const format = normalizeMenuItem(
      selectionMenuConfig?.format,
      true,
      'Format'
    );
    const copyAsMarkdown = normalizeMenuItem(
      selectionMenuConfig?.copyAsMarkdown,
      true,
      'Copy as Markdown'
    );
    return {
      format: format.enabled,
      formatLabel: format.label,
      copyAsMarkdown: copyAsMarkdown.enabled,
      copyAsMarkdownLabel: copyAsMarkdown.label,
    };
  }, [selectionMenuConfig]);

  const normalizedFormatMenuConfig = useMemo(() => {
    const bold = normalizeMenuItem(formatMenuConfig?.bold, true, 'Bold');
    const italic = normalizeMenuItem(formatMenuConfig?.italic, true, 'Italic');
    const underline = normalizeMenuItem(
      formatMenuConfig?.underline,
      true,
      'Underline'
    );
    const strikethrough = normalizeMenuItem(
      formatMenuConfig?.strikethrough,
      true,
      'Strikethrough'
    );
    const spoiler = normalizeMenuItem(
      formatMenuConfig?.spoiler,
      true,
      'Spoiler'
    );
    const link = normalizeMenuItem(formatMenuConfig?.link, true, 'Link');
    return {
      bold: bold.enabled,
      boldLabel: bold.label,
      italic: italic.enabled,
      italicLabel: italic.label,
      underline: underline.enabled,
      underlineLabel: underline.label,
      strikethrough: strikethrough.enabled,
      strikethroughLabel: strikethrough.label,
      spoiler: spoiler.enabled,
      spoilerLabel: spoiler.label,
      link: link.enabled,
      linkLabel: link.label,
    };
  }, [formatMenuConfig]);

  const normalizedMarkdownShortcuts = useMemo(
    () => normalizeMarkdownShortcuts(markdownShortcuts),
    [markdownShortcuts]
  );

  const linkRegex = useMemo(
    () => toNativeRegexConfig(_linkRegex),
    [_linkRegex]
  );

  const handleLinkDetected = useCallback(
    (e: NativeSyntheticEvent<OnLinkDetected>) => {
      const { text, url, start, end } = e.nativeEvent;
      onLinkDetected?.({ text, url, start, end });
    },
    [onLinkDetected]
  );

  const handleChangeText = useCallback(
    (e: NativeSyntheticEvent<OnChangeTextEvent>) => {
      onChangeText?.(e.nativeEvent.value);
    },
    [onChangeText]
  );

  const handleChangeMarkdown = useCallback(
    (e: NativeSyntheticEvent<OnChangeMarkdownEvent>) => {
      onChangeMarkdown?.(e.nativeEvent.value);
    },
    [onChangeMarkdown]
  );

  const handleChangeSelection = useCallback(
    (e: NativeSyntheticEvent<OnChangeSelectionEvent>) => {
      const { start, end } = e.nativeEvent;
      onChangeSelection?.({ start, end });
    },
    [onChangeSelection]
  );

  const handleChangeState = useCallback(
    (e: NativeSyntheticEvent<OnChangeStateEvent>) => {
      const {
        bold,
        italic,
        underline,
        strikethrough,
        spoiler,
        link,
        heading,
        unorderedList,
        orderedList,
      } = e.nativeEvent;
      onChangeState?.({
        bold,
        italic,
        underline,
        strikethrough,
        spoiler,
        link,
        heading: { ...heading, level: toHeadingLevel(heading.level) },
        unorderedList,
        orderedList,
      });
    },
    [onChangeState]
  );

  const handleCaretRectChange = useCallback(
    (e: NativeSyntheticEvent<OnCaretRectChangeEvent>) => {
      const { x, y, width, height } = e.nativeEvent;
      onCaretRectChange?.({ x, y, width, height });
    },
    [onCaretRectChange]
  );

  const handleStartMention = useCallback(
    (e: NativeSyntheticEvent<OnStartMentionEvent>) => {
      onStartMention?.(e.nativeEvent);
    },
    [onStartMention]
  );

  const handleChangeMention = useCallback(
    (e: NativeSyntheticEvent<OnChangeMentionEvent>) => {
      onChangeMention?.(e.nativeEvent);
    },
    [onChangeMention]
  );

  const handleEndMention = useCallback(
    (e: NativeSyntheticEvent<OnEndMentionEvent>) => {
      onEndMention?.(e.nativeEvent);
    },
    [onEndMention]
  );

  const handleFocus = useCallback(() => {
    TextInputState.focusInput(nativeRef.current);
    onFocus?.();
  }, [onFocus]);

  const handleBlur = useCallback(() => {
    TextInputState.blurInput(nativeRef.current);
    onBlur?.();
  }, [onBlur]);

  /**
   * React Native TextInput attaches usePressability to the native host so taps
   * claim the JS touch responder and ancestor Pressable handlers do not also
   * run.
   * https://github.com/react/react-native/blob/v0.86.2/packages/react-native/Libraries/Components/TextInput/TextInput.js#L582-L616
   */
  const pressabilityConfig = useMemo(
    () => ({
      cancelable:
        Platform.OS === 'ios' ? !rejectResponderTermination : undefined,
      hitSlop,
      onPress: (event: GestureResponderEvent) => {
        onPress?.(event);
        if (editable !== false) {
          // Same call TextInput's host focus() makes. A tap on the text view
          // focuses it natively, which makes this a no-op; it matters when the
          // press lands outside the native view, e.g. in the hitSlop area.
          TextInputState.focusTextInput(nativeRef.current);
        }
      },
      onPressIn,
      onPressOut,
    }),
    [
      editable,
      hitSlop,
      onPress,
      onPressIn,
      onPressOut,
      rejectResponderTermination,
    ]
  );

  // TextInput handles onBlur and onFocus events
  // so omitting onBlur and onFocus pressability handlers here.
  //
  // Same logic as https://github.com/react/react-native/blob/v0.86.2/packages/react-native/Libraries/Components/TextInput/TextInput.js#L629
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onBlur: _onBlur,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onFocus: _onFocus,
    ...pressabilityHandlers
  } = usePressability(pressabilityConfig) ?? {};

  const handleRequestMarkdownResult = useCallback(
    (e: NativeSyntheticEvent<OnRequestMarkdownResultEvent>) => {
      const { requestId, markdown } = e.nativeEvent;
      const pending = pendingRequests.current.get(requestId);
      if (!pending) return;

      pending.resolve(markdown);
      pendingRequests.current.delete(requestId);
    },
    []
  );

  const handleRequestCaretRectResult = useCallback(
    (e: NativeSyntheticEvent<OnRequestCaretRectResultEvent>) => {
      const { requestId, x, y, width, height } = e.nativeEvent;
      const pending = pendingCaretRectRequests.current.get(requestId);
      if (!pending) return;

      pending.resolve({ x, y, width, height });
      pendingCaretRectRequests.current.delete(requestId);
    },
    []
  );

  const handleContextMenuItemPress = useCallback(
    (e: NativeSyntheticEvent<OnContextMenuItemPressEvent>) => {
      const {
        itemText,
        selectedText,
        selectionStart,
        selectionEnd,
        styleState,
      } = e.nativeEvent;
      const callback = contextMenuCallbacksRef.current.get(itemText);
      callback?.({
        text: selectedText,
        selection: { start: selectionStart, end: selectionEnd },
        styleState: {
          ...styleState,
          heading: {
            ...styleState.heading,
            level: toHeadingLevel(styleState.heading.level),
          },
        },
      });
    },
    []
  );

  useImperativeHandle(ref, () => {
    const node = getNativeRef(nativeRef);
    // Codegen's ViewRef resolves to `never` with RN 0.84's function-based
    // HostComponent type — the cast is safe at runtime.
    const commandRef = node as Parameters<(typeof Commands)['focus']>[0];
    return {
      measure: (callback) => node.measure(callback),
      measureInWindow: (callback) => node.measureInWindow(callback),
      measureLayout: (relativeToNativeNode, onSuccess, onFail) =>
        node.measureLayout(relativeToNativeNode, onSuccess, onFail),
      focus: () => Commands.focus(commandRef),
      blur: () => Commands.blur(commandRef),
      setValue: (markdown) => Commands.setValue(commandRef, markdown),
      setSelection: (start, end) =>
        Commands.setSelection(commandRef, start, end),
      toggleBold: () => Commands.toggleBold(commandRef),
      toggleItalic: () => Commands.toggleItalic(commandRef),
      toggleUnderline: () => Commands.toggleUnderline(commandRef),
      toggleStrikethrough: () => Commands.toggleStrikethrough(commandRef),
      toggleSpoiler: () => Commands.toggleSpoiler(commandRef),
      toggleHeading: (level) => Commands.toggleHeading(commandRef, level),
      toggleUnorderedList: () => Commands.toggleUnorderedList(commandRef),
      toggleOrderedList: () => Commands.toggleOrderedList(commandRef),
      indentList: () => Commands.indentList(commandRef),
      outdentList: () => Commands.outdentList(commandRef),
      setLink: (url) => Commands.setLink(commandRef, url),
      insertLink: (text, url) => Commands.insertLink(commandRef, text, url),
      insertText: (text) => Commands.insertText(commandRef, text),
      insertMention: (displayText, url) =>
        Commands.insertMention(commandRef, displayText, url),
      startMention: (indicator) => Commands.startMention(commandRef, indicator),
      removeLink: () => Commands.removeLink(commandRef),
      copyToClipboard: () => Commands.copyToClipboard(commandRef),
      getMarkdown: () =>
        new Promise<string>((resolve, reject) => {
          const requestId = nextRequestId.current++;
          pendingRequests.current.set(requestId, { resolve, reject });
          Commands.requestMarkdown(commandRef, requestId);
        }),
      getCaretRect: () =>
        new Promise<CaretRect>((resolve, reject) => {
          const requestId = nextRequestId.current++;
          pendingCaretRectRequests.current.set(requestId, {
            resolve,
            reject,
          });
          Commands.requestCaretRect(commandRef, requestId);
        }),
    };
  });

  return (
    <EnrichedMarkdownTextInputNativeComponent
      ref={nativeRef}
      style={style}
      markdownStyle={normalizedStyle}
      defaultValue={initialDefaultValue}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      editable={editable}
      autoFocus={autoFocus}
      scrollEnabled={scrollEnabled}
      markdownShortcuts={normalizedMarkdownShortcuts}
      autoCapitalize={autoCapitalize}
      multiline={multiline}
      cursorColor={cursorColor}
      selectionColor={selectionColor}
      isOnChangeMarkdownSet={onChangeMarkdown !== undefined}
      onChangeText={handleChangeText as NativeProps['onChangeText']}
      onChangeMarkdown={handleChangeMarkdown as NativeProps['onChangeMarkdown']}
      onChangeSelection={
        handleChangeSelection as NativeProps['onChangeSelection']
      }
      onChangeState={handleChangeState as NativeProps['onChangeState']}
      onInputKeyPress={onKeyPress as NativeProps['onInputKeyPress']}
      onLinkDetected={handleLinkDetected as NativeProps['onLinkDetected']}
      onInputFocus={handleFocus as NativeProps['onInputFocus']}
      onInputBlur={handleBlur as NativeProps['onInputBlur']}
      onRequestMarkdownResult={
        handleRequestMarkdownResult as NativeProps['onRequestMarkdownResult']
      }
      onRequestCaretRectResult={
        handleRequestCaretRectResult as NativeProps['onRequestCaretRectResult']
      }
      onCaretRectChange={
        handleCaretRectChange as NativeProps['onCaretRectChange']
      }
      contextMenuItems={nativeContextMenuItems}
      selectionMenuConfig={normalizedSelectionMenuConfig}
      formatMenuConfig={normalizedFormatMenuConfig}
      mentionIndicators={mentionIndicators}
      onContextMenuItemPress={
        handleContextMenuItemPress as NativeProps['onContextMenuItemPress']
      }
      linkRegex={linkRegex}
      writingDirection={writingDirection}
      onStartMention={handleStartMention as NativeProps['onStartMention']}
      onChangeMention={handleChangeMention as NativeProps['onChangeMention']}
      onEndMention={handleEndMention as NativeProps['onEndMention']}
      // Explicitly pass through hitSlop because the native view subclasses
      // RCTViewComponentView and makes use of hitSlop too
      hitSlop={hitSlop}
      {...rest}
      {...pressabilityHandlers}
    />
  );
};

export default EnrichedMarkdownTextInput;
