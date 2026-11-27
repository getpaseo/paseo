import {
  codegenNativeComponent,
  codegenNativeCommands,
  type ViewProps,
  type ColorValue,
  type HostComponent,
  type CodegenTypes,
} from 'react-native';
import type React from 'react';

interface HeadingStyleInternal {
  fontSize: CodegenTypes.Float;
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
  linkVariants: ReadonlyArray<
    Readonly<{
      pattern: string;
      color: ColorValue;
      underline: boolean;
      backgroundColor: ColorValue;
    }>
  >;
  spoiler: {
    color: ColorValue;
    backgroundColor: ColorValue;
  };
  // Per-level heading styles, mirroring the readonly renderer's markdownStyle
  // h1..h6 so heading sizing is configured consistently across read and edit
  // views. Always provided with complete defaults via normalizeMarkdownTextInputStyle.
  h1: HeadingStyleInternal;
  h2: HeadingStyleInternal;
  h3: HeadingStyleInternal;
  h4: HeadingStyleInternal;
  h5: HeadingStyleInternal;
  h6: HeadingStyleInternal;
  list: {
    // Vertical spacing (points) added above each list item. iOS applies it via
    // paragraphSpacingBefore; Android via a LineHeightSpan. Float for parity with
    // every other spacing value in the library.
    itemSpacing: CodegenTypes.Float;
  };
}

interface TargetedEvent {
  target: CodegenTypes.Int32;
}

export interface OnChangeTextEvent {
  value: string;
}

export interface OnChangeMarkdownEvent {
  value: string;
}

export interface OnKeyPressEvent {
  key: string;
}

export interface OnChangeSelectionEvent {
  start: CodegenTypes.Int32;
  end: CodegenTypes.Int32;
}

export interface OnChangeStateEvent {
  bold: { isActive: boolean };
  italic: { isActive: boolean };
  underline: { isActive: boolean };
  strikethrough: { isActive: boolean };
  spoiler: { isActive: boolean };
  link: { isActive: boolean; destination: string };
  heading: { isActive: boolean; level: CodegenTypes.Int32 };
  unorderedList: { isActive: boolean; depth: CodegenTypes.Int32 };
  orderedList: { isActive: boolean; depth: CodegenTypes.Int32 };
}

export interface OnRequestMarkdownResultEvent {
  requestId: CodegenTypes.Int32;
  markdown: string;
}

export interface OnRequestCaretRectResultEvent {
  requestId: CodegenTypes.Int32;
  x: CodegenTypes.Double;
  y: CodegenTypes.Double;
  width: CodegenTypes.Double;
  height: CodegenTypes.Double;
}

export interface OnCaretRectChangeEvent {
  x: CodegenTypes.Double;
  y: CodegenTypes.Double;
  width: CodegenTypes.Double;
  height: CodegenTypes.Double;
}

export interface LinkNativeRegex {
  pattern: string;
  caseInsensitive: boolean;
  dotAll: boolean;
  isDisabled: boolean;
  isDefault: boolean;
}

export interface OnLinkDetected {
  text: string;
  url: string;
  start: CodegenTypes.Int32;
  end: CodegenTypes.Int32;
}

export interface OnStartMentionEvent {
  indicator: string;
}

export interface OnChangeMentionEvent {
  indicator: string;
  text: string;
}

export interface OnEndMentionEvent {
  indicator: string;
}

export interface ContextMenuItemConfig {
  text: string;
  icon?: string;
}

export interface InputSelectionMenuConfigInternal {
  format: boolean;
  formatLabel: string;
  copyAsMarkdown: boolean;
  copyAsMarkdownLabel: string;
}

export interface FormatMenuConfigInternal {
  bold: boolean;
  boldLabel: string;
  italic: boolean;
  italicLabel: string;
  underline: boolean;
  underlineLabel: string;
  strikethrough: boolean;
  strikethroughLabel: string;
  spoiler: boolean;
  spoilerLabel: string;
  link: boolean;
  linkLabel: string;
}

export interface MarkdownShortcutsConfigInternal {
  heading: boolean;
  unorderedList: boolean;
  orderedList: boolean;
}

export interface OnContextMenuItemPressEvent {
  itemText: string;
  selectedText: string;
  selectionStart: CodegenTypes.Int32;
  selectionEnd: CodegenTypes.Int32;
  styleState: {
    bold: { isActive: boolean };
    italic: { isActive: boolean };
    underline: { isActive: boolean };
    strikethrough: { isActive: boolean };
    spoiler: { isActive: boolean };
    link: { isActive: boolean; destination: string };
    heading: { isActive: boolean; level: CodegenTypes.Int32 };
    unorderedList: { isActive: boolean; depth: CodegenTypes.Int32 };
    orderedList: { isActive: boolean; depth: CodegenTypes.Int32 };
  };
}

export interface NativeProps extends ViewProps {
  /**
   * Initial markdown content.
   */
  defaultValue?: string;
  /**
   * Placeholder text shown when the input is empty.
   */
  placeholder?: string;
  /**
   * Color of the placeholder text.
   */
  placeholderTextColor?: ColorValue;
  /**
   * Whether the input is editable.
   * @default true
   */
  editable?: boolean;
  /**
   * Whether the input should auto-focus on mount.
   * @default false
   */
  autoFocus?: boolean;
  /**
   * Whether the input is scrollable.
   * @default true
   */
  scrollEnabled?: boolean;
  /**
   * Which markdown block prefixes typed at a paragraph start convert into the
   * matching block. Always complete — the JS side normalizes the public
   * `boolean | MarkdownShortcutsConfig` form before it gets here.
   */
  markdownShortcuts: Readonly<MarkdownShortcutsConfigInternal>;
  /**
   * Auto-capitalization behavior.
   */
  autoCapitalize?: string;
  /**
   * Whether the input supports multiple lines.
   * @default true
   */
  multiline?: boolean;
  /**
   * Color of the cursor.
   */
  cursorColor?: ColorValue;
  /**
   * Color of the text selection highlight.
   */
  selectionColor?: ColorValue;
  /**
   * Inline format style overrides.
   * Always provided with complete defaults via normalizeMarkdownTextInputStyle.
   */
  markdownStyle: MarkdownTextInputStyleInternal;

  // These should not be passed as regular props.
  color?: ColorValue;
  fontSize?: CodegenTypes.Float;
  lineHeight?: CodegenTypes.Float;
  fontFamily?: string;
  fontWeight?: string;

  /**
   * Whether onChangeMarkdown handler is set. When true, the native side
   * serializes formatting ranges to Markdown on every change.
   */
  isOnChangeMarkdownSet?: boolean;

  /**
   * Custom items to show in the text selection context menu.
   * Each item is shown by its `text` label; invisible items should be filtered out before passing here.
   */
  contextMenuItems?: ReadonlyArray<Readonly<ContextMenuItemConfig>>;

  /**
   * Controls built-in items in the text selection context menu.
   * `format` toggles the Format submenu; `copyAsMarkdown` toggles the Copy as Markdown action.
   */
  selectionMenuConfig: Readonly<InputSelectionMenuConfigInternal>;

  /**
   * Controls which items appear inside the Format submenu.
   */
  formatMenuConfig: Readonly<FormatMenuConfigInternal>;

  /**
   * Regex configuration for automatic link detection.
   * Omit or pass undefined to use platform defaults.
   */
  linkRegex?: Readonly<LinkNativeRegex>;

  /**
   * List of trigger strings that start a mention flow (e.g. `['@', '#']`).
   * Detection fires when the cursor is immediately after a token that starts with one of these strings.
   */
  mentionIndicators?: ReadonlyArray<string>;

  /**
   * Paragraph writing direction.
   * - 'first-strong' (default): resolves each paragraph from its first strong directional character;
   *   neutral-only paragraphs fall back to the view's resolved layout direction. Library extension —
   *   matches Android's TEXT_DIRECTION_FIRST_STRONG.
   * - 'auto': React Native parity; iOS TextKit follows the app's userInterfaceLayoutDirection.
   * - 'ltr' / 'rtl': force base direction on every paragraph.
   * @default 'first-strong'
   * @platform ios
   */
  writingDirection?: CodegenTypes.WithDefault<string, 'first-strong'>;

  // Events
  onChangeText?: CodegenTypes.DirectEventHandler<OnChangeTextEvent>;
  onChangeMarkdown?: CodegenTypes.DirectEventHandler<OnChangeMarkdownEvent>;
  onChangeSelection?: CodegenTypes.DirectEventHandler<OnChangeSelectionEvent>;
  onInputKeyPress?: CodegenTypes.DirectEventHandler<OnKeyPressEvent>;
  onChangeState?: CodegenTypes.DirectEventHandler<OnChangeStateEvent>;
  onInputFocus?: CodegenTypes.DirectEventHandler<TargetedEvent>;
  onInputBlur?: CodegenTypes.DirectEventHandler<TargetedEvent>;
  onRequestMarkdownResult?: CodegenTypes.DirectEventHandler<OnRequestMarkdownResultEvent>;
  onRequestCaretRectResult?: CodegenTypes.DirectEventHandler<OnRequestCaretRectResultEvent>;
  onCaretRectChange?: CodegenTypes.DirectEventHandler<OnCaretRectChangeEvent>;
  onContextMenuItemPress?: CodegenTypes.DirectEventHandler<OnContextMenuItemPressEvent>;
  onLinkDetected?: CodegenTypes.DirectEventHandler<OnLinkDetected>;
  onStartMention?: CodegenTypes.DirectEventHandler<OnStartMentionEvent>;
  onChangeMention?: CodegenTypes.DirectEventHandler<OnChangeMentionEvent>;
  onEndMention?: CodegenTypes.DirectEventHandler<OnEndMentionEvent>;
}

type ComponentType = HostComponent<NativeProps>;

interface NativeCommands {
  focus: (viewRef: React.ElementRef<ComponentType>) => void;
  blur: (viewRef: React.ElementRef<ComponentType>) => void;
  setValue: (
    viewRef: React.ElementRef<ComponentType>,
    markdown: string
  ) => void;
  setSelection: (
    viewRef: React.ElementRef<ComponentType>,
    start: CodegenTypes.Int32,
    end: CodegenTypes.Int32
  ) => void;
  toggleBold: (viewRef: React.ElementRef<ComponentType>) => void;
  toggleItalic: (viewRef: React.ElementRef<ComponentType>) => void;
  toggleUnderline: (viewRef: React.ElementRef<ComponentType>) => void;
  toggleStrikethrough: (viewRef: React.ElementRef<ComponentType>) => void;
  toggleSpoiler: (viewRef: React.ElementRef<ComponentType>) => void;
  toggleHeading: (
    viewRef: React.ElementRef<ComponentType>,
    level: CodegenTypes.Int32
  ) => void;
  toggleUnorderedList: (viewRef: React.ElementRef<ComponentType>) => void;
  toggleOrderedList: (viewRef: React.ElementRef<ComponentType>) => void;
  indentList: (viewRef: React.ElementRef<ComponentType>) => void;
  outdentList: (viewRef: React.ElementRef<ComponentType>) => void;
  setLink: (viewRef: React.ElementRef<ComponentType>, url: string) => void;
  insertLink: (
    viewRef: React.ElementRef<ComponentType>,
    text: string,
    url: string
  ) => void;
  insertText: (viewRef: React.ElementRef<ComponentType>, text: string) => void;
  insertMention: (
    viewRef: React.ElementRef<ComponentType>,
    displayText: string,
    url: string
  ) => void;
  startMention: (
    viewRef: React.ElementRef<ComponentType>,
    indicator: string
  ) => void;
  removeLink: (viewRef: React.ElementRef<ComponentType>) => void;
  copyToClipboard: (viewRef: React.ElementRef<ComponentType>) => void;
  requestMarkdown: (
    viewRef: React.ElementRef<ComponentType>,
    requestId: CodegenTypes.Int32
  ) => void;
  requestCaretRect: (
    viewRef: React.ElementRef<ComponentType>,
    requestId: CodegenTypes.Int32
  ) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
  supportedCommands: [
    'focus',
    'blur',
    'setValue',
    'setSelection',
    'toggleBold',
    'toggleItalic',
    'toggleUnderline',
    'toggleStrikethrough',
    'toggleSpoiler',
    'toggleHeading',
    'toggleUnorderedList',
    'toggleOrderedList',
    'indentList',
    'outdentList',
    'setLink',
    'insertLink',
    'insertText',
    'insertMention',
    'startMention',
    'removeLink',
    'copyToClipboard',
    'requestMarkdown',
    'requestCaretRect',
  ],
});

export default codegenNativeComponent<NativeProps>(
  'EnrichedMarkdownTextInput',
  {
    interfaceOnly: true,
  }
) as HostComponent<NativeProps>;
