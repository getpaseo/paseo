import {
  codegenNativeComponent,
  type ViewProps,
  type CodegenTypes,
  type ColorValue,
} from 'react-native';

// All block styles extend this interface
interface BaseBlockStyleInternal {
  fontSize: CodegenTypes.Float;
  fontFamily: string;
  fontWeight: string;
  color: ColorValue;
  marginTop: CodegenTypes.Float;
  marginBottom: CodegenTypes.Float;
  lineHeight: CodegenTypes.Float;
}

interface ParagraphStyleInternal extends BaseBlockStyleInternal {
  textAlign: string;
}

interface HeadingStyleInternal extends BaseBlockStyleInternal {
  textAlign: string;
}

interface AdmonitionColorsInternal {
  color: ColorValue;
  backgroundColor: ColorValue;
}

interface AdmonitionsStyleInternal {
  note: AdmonitionColorsInternal;
  tip: AdmonitionColorsInternal;
  important: AdmonitionColorsInternal;
  warning: AdmonitionColorsInternal;
  caution: AdmonitionColorsInternal;
}

interface BlockquoteStyleInternal extends BaseBlockStyleInternal {
  borderColor: ColorValue;
  borderWidth: CodegenTypes.Float;
  gapWidth: CodegenTypes.Float;
  backgroundColor: ColorValue;
  borderRadius: CodegenTypes.Float;
  padding: CodegenTypes.Float;
  admonitions: AdmonitionsStyleInternal;
}

interface ListStyleInternal extends BaseBlockStyleInternal {
  bulletColor: ColorValue;
  bulletSize: CodegenTypes.Float;
  markerMinWidth: CodegenTypes.Float;
  markerColor: ColorValue;
  markerFontWeight: string;
  gapWidth: CodegenTypes.Float;
  marginLeft: CodegenTypes.Float;
  itemSpacing: CodegenTypes.Float;
}

interface CodeBlockSyntaxColorsInternal {
  keyword: ColorValue;
  operatorColor: ColorValue;
  punctuation: ColorValue;
  string: ColorValue;
  number: ColorValue;
  constant: ColorValue;
  comment: ColorValue;
  function: ColorValue;
  type: ColorValue;
  variable: ColorValue;
  property: ColorValue;
  tag: ColorValue;
  attribute: ColorValue;
  embedded: ColorValue;
}

interface CodeBlockStyleInternal extends BaseBlockStyleInternal {
  backgroundColor: ColorValue;
  borderColor: ColorValue;
  borderRadius: CodegenTypes.Float;
  borderWidth: CodegenTypes.Float;
  padding: CodegenTypes.Float;
  syntaxColors: CodeBlockSyntaxColorsInternal;
}

interface LinkStyleInternal {
  fontFamily: string;
  color: ColorValue;
  underline: boolean;
  backgroundColor: ColorValue;
}

interface LinkPillInternal {
  enabled: boolean;
  label: string;
  iconUri: string;
  iconTintColor?: ColorValue;
  borderRadius: CodegenTypes.Float;
  paddingHorizontal: CodegenTypes.Float;
  paddingVertical: CodegenTypes.Float;
  lineHeight: CodegenTypes.Float;
  borderWidth: CodegenTypes.Float;
  borderColor: ColorValue;
  maxWidth: CodegenTypes.Float;
}

// Mirrors EnrichedMarkdownNativeComponent.ts — kept in sync manually (codegen spec files must be self-contained).
interface LinkVariantEntryInternal {
  pattern: string;
  color: ColorValue;
  underline: boolean;
  backgroundColor: ColorValue;
  fontFamily: string;
  pill: LinkPillInternal;
}

interface StrongStyleInternal {
  fontFamily: string;
  fontWeight: string;
  color?: ColorValue;
}

interface EmphasisStyleInternal {
  fontFamily: string;
  fontStyle: string;
  color?: ColorValue;
}

interface StrikethroughStyleInternal {
  color: ColorValue;
}

interface UnderlineStyleInternal {
  color: ColorValue;
}

interface CodeStyleInternal {
  fontFamily: string;
  fontSize: CodegenTypes.Float;
  color: ColorValue;
  backgroundColor: ColorValue;
  borderColor: ColorValue;
}

interface ImageStyleInternal {
  height: CodegenTypes.Float;
  maxHeight: CodegenTypes.Float;
  aspectRatio: CodegenTypes.Float;
  // Nested struct fields cannot use WithDefault; default is applied in JS normalization.
  resizeMode: string;
  borderRadius: CodegenTypes.Float;
  marginTop: CodegenTypes.Float;
  marginBottom: CodegenTypes.Float;
}

interface VideoStyleInternal {
  marginTop: CodegenTypes.Float;
  marginBottom: CodegenTypes.Float;
  borderRadius: CodegenTypes.Float;
  aspectRatio: CodegenTypes.Float;
  backgroundColor: ColorValue;
}

interface InlineImageStyleInternal {
  size: CodegenTypes.Float;
}

interface ThematicBreakStyleInternal {
  color: ColorValue;
  height: CodegenTypes.Float;
  marginTop: CodegenTypes.Float;
  marginBottom: CodegenTypes.Float;
}

interface TableStyleInternal extends BaseBlockStyleInternal {
  headerFontFamily: string;
  headerBackgroundColor: ColorValue;
  headerTextColor: ColorValue;
  rowEvenBackgroundColor: ColorValue;
  rowOddBackgroundColor: ColorValue;
  borderColor: ColorValue;
  borderWidth: CodegenTypes.Float;
  borderRadius: CodegenTypes.Float;
  cellPaddingHorizontal: CodegenTypes.Float;
  cellPaddingVertical: CodegenTypes.Float;
  horizontalOverflow: CodegenTypes.Float;
  align: string;
}

interface TaskListStyleInternal {
  checkedColor: ColorValue;
  borderColor: ColorValue;
  checkboxSize: CodegenTypes.Float;
  checkboxBorderRadius: CodegenTypes.Float;
  checkmarkColor: ColorValue;
  checkedTextColor: ColorValue;
  checkedStrikethrough: boolean;
}

interface MathStyleInternal {
  fontSize: CodegenTypes.Float;
  color: ColorValue;
  backgroundColor: ColorValue;
  padding: CodegenTypes.Float;
  marginTop: CodegenTypes.Float;
  marginBottom: CodegenTypes.Float;
  textAlign: string;
}

interface InlineMathStyleInternal {
  color: ColorValue;
}

interface SpoilerParticlesStyleInternal {
  density: CodegenTypes.Float;
  speed: CodegenTypes.Float;
}

interface SpoilerSolidStyleInternal {
  borderRadius: CodegenTypes.Float;
}

interface SpoilerStyleInternal {
  color: ColorValue;
  particles: SpoilerParticlesStyleInternal;
  solid: SpoilerSolidStyleInternal;
}

interface SuperscriptStyleInternal {
  fontScale: CodegenTypes.Float;
  baselineOffsetScale: CodegenTypes.Float;
}

interface SubscriptStyleInternal {
  fontScale: CodegenTypes.Float;
  baselineOffsetScale: CodegenTypes.Float;
}

interface HighlightStyleInternal {
  color: ColorValue;
  backgroundColor: ColorValue;
}

export interface MarkdownStyleInternal {
  paragraph: ParagraphStyleInternal;
  h1: HeadingStyleInternal;
  h2: HeadingStyleInternal;
  h3: HeadingStyleInternal;
  h4: HeadingStyleInternal;
  h5: HeadingStyleInternal;
  h6: HeadingStyleInternal;
  blockquote: BlockquoteStyleInternal;
  list: ListStyleInternal;
  codeBlock: CodeBlockStyleInternal;
  link: LinkStyleInternal;
  linkVariants: ReadonlyArray<Readonly<LinkVariantEntryInternal>>;
  strong: StrongStyleInternal;
  em: EmphasisStyleInternal;
  strikethrough: StrikethroughStyleInternal;
  underline: UnderlineStyleInternal;
  code: CodeStyleInternal;
  image: ImageStyleInternal;
  video: VideoStyleInternal;
  inlineImage: InlineImageStyleInternal;
  thematicBreak: ThematicBreakStyleInternal;
  table: TableStyleInternal;
  taskList: TaskListStyleInternal;
  math: MathStyleInternal;
  inlineMath: InlineMathStyleInternal;
  spoiler: SpoilerStyleInternal;
  superscript: SuperscriptStyleInternal;
  subscript: SubscriptStyleInternal;
  highlight: HighlightStyleInternal;
}

export interface LinkPressEvent {
  url: string;
  sourceType: string;
}

export interface LinkLongPressEvent {
  url: string;
}

export interface ImagePressEvent {
  url: string;
  altText: string;
}

export interface TaskListItemPressEvent {
  index: CodegenTypes.Int32;
  checked: boolean;
  text: string;
}

export interface CopyPressEvent {
  code: string;
  language: string;
}

export interface LatexErrorEvent {
  source: string;
  message: string;
  displayMode: boolean;
}

export interface CodeBlockPressEvent {
  code: string;
  language: string;
}

export interface ContextMenuItemConfig {
  text: string;
  icon?: string;
}

export interface ImageRequestHeaderInternal {
  name: string;
  value: string;
}

export interface LinkPillContentInternal {
  url: string;
  label: string;
  iconUri: string;
  iconTintColor?: ColorValue;
}

export interface SelectionMenuConfig {
  copyAsMarkdown: boolean;
  copyImageUrl: boolean;
  copyLabel: string;
  copyAsMarkdownLabel: string;
  copyImageUrlLabel: string;
  copyImageUrlsLabel: string;
  // Precomputed plural templates indexed by image count (0..100). Empty when no
  // pluralLabels are set; native then uses copyImageUrlLabel/copyImageUrlsLabel.
  copyImageUrlPluralTemplates: ReadonlyArray<string>;
}

export interface OnContextMenuItemPressEvent {
  itemText: string;
  selectedText: string;
  selectionStart: CodegenTypes.Int32;
  selectionEnd: CodegenTypes.Int32;
}

export interface AccessibilityLabelsListProps {
  bulletPoint: string;
  nestedBulletPoint: string;
  orderedItem: string;
  nestedOrderedItem: string;
}
export interface AccessibilityLabelsBlockquoteProps {
  quote: string;
  nestedQuote: string;
}
export interface AccessibilityLabelsTableProps {
  row: string;
}
export interface AccessibilityLabelsMathProps {
  equation: string;
}
export interface AccessibilityLabelsRotorProps {
  headings: string;
  links: string;
  images: string;
}
export interface AccessibilityLabelsProps {
  list: Readonly<AccessibilityLabelsListProps>;
  blockquote: Readonly<AccessibilityLabelsBlockquoteProps>;
  table: Readonly<AccessibilityLabelsTableProps>;
  math: Readonly<AccessibilityLabelsMathProps>;
  rotor: Readonly<AccessibilityLabelsRotorProps>;
}

/**
 * MD4C parser flags configuration.
 * Controls how the markdown parser interprets certain syntax.
 */
export interface Md4cFlagsInternal {
  /**
   * Enable underline syntax support (__text__).
   * When enabled, underscores are treated as underline markers.
   * When disabled, underscores are treated as emphasis markers (same as asterisks).
   * @default false
   */
  underline: boolean;
  /**
   * Enable superscript span parsing (^text^).
   * @default false
   */
  superscript: boolean;
  /**
   * Enable subscript span parsing (~text~).
   * @default false
   */
  subscript: boolean;
  /**
   * Enable LaTeX math span parsing ($..$ and $$..$$).
   * When disabled, dollar signs are treated as plain text.
   * @default true
   */
  latexMath: boolean;
  /**
   * Enable highlight span parsing (==text==).
   * @default false
   */
  highlight: boolean;
  /**
   * Treat soft breaks (single newlines) as hard breaks (visible line breaks).
   * @default false
   */
  hardSoftBreaks: boolean;
  /**
   * Preserve runs of consecutive blank lines as extra empty lines.
   * @default false
   */
  preserveBlankLines: boolean;
  /**
   * Enable GitHub-style admonitions/alerts extension.
   * Forced off for `flavor="commonmark"`.
   * @default true
   */
  admonitions: boolean;
}

interface StreamingConfigInternal {
  tableMode: string;
  codeBlockMode: string;
}

interface LinkContextMenuItemConfig {
  text: string;
  icon: string;
  disabled: boolean;
  destructive: boolean;
}

interface LinkContextMenuItemsConfig {
  pattern: string;
  items: ReadonlyArray<Readonly<LinkContextMenuItemConfig>>;
}

interface OnLinkContextMenuItemPressEvent {
  url: string;
  pattern: string;
  itemText: string;
}

interface TextLinkNativeRegex {
  pattern: string;
  caseInsensitive: boolean;
  dotAll: boolean;
  isDisabled: boolean;
  isDefault: boolean;
}

export interface NativeProps extends ViewProps {
  /**
   * Markdown content to render.
   */
  markdown: string;
  /**
   * Internal style configuration for markdown elements.
   * Always provided with complete defaults via normalizeMarkdownStyle.
   * Block styles (paragraph, headings) contain fontSize, fontFamily, fontWeight, and color.
   */
  markdownStyle: MarkdownStyleInternal;
  /**
   * Callback fired when a link is pressed.
   * Receives the URL that was tapped.
   */
  onLinkPress?: CodegenTypes.BubblingEventHandler<LinkPressEvent>;
  /**
   * Callback fired when a link is long pressed.
   * Receives the URL that was long pressed.
   * - iOS: When provided, overrides the system link preview behavior.
   * - Android: Handles long press gestures on links.
   */
  onLinkLongPress?: CodegenTypes.BubblingEventHandler<LinkLongPressEvent>;
  /**
   * Callback fired when a rendered image is tapped.
   * Receives the image URL and its alt text (empty string when the image has
   * no alt text). Images that are also links keep link behavior and emit
   * `onLinkPress` instead, so a single tap never fires both.
   */
  onImagePress?: CodegenTypes.BubblingEventHandler<ImagePressEvent>;
  /**
   * Gates native image tap handling. Set automatically to `true` by the JS
   * wrapper when `onImagePress` is provided. When `false` (default), images are
   * inert: taps fall through to text selection and the iOS Copy/Save menu
   * exactly as before, and no image span becomes interactive on Android.
   *
   * @default false
   */
  enableImagePress?: CodegenTypes.WithDefault<boolean, false>;
  /**
   * Callback fired when a task list checkbox is tapped.
   * Receives the 0-based task index, current checked state, and the item's plain text.
   */
  onTaskListItemPress?: CodegenTypes.BubblingEventHandler<TaskListItemPressEvent>;
  /**
   * Controls whether tapping a task list checkbox toggles its checked state.
   *
   * When `false`, the tap is fully inert: no visual toggle and no
   * `onTaskListItemPress` emission. Text selection and links are unaffected.
   *
   * @default true
   */
  enableTaskListItemToggle?: CodegenTypes.WithDefault<boolean, true>;
  /**
   * Callback fired when code is copied from a fenced code block's header copy
   * button, its long-press context-menu "Copy" action, or the VoiceOver copy
   * action. Receives the copied code and its language.
   */
  onCopyPress?: CodegenTypes.BubblingEventHandler<CopyPressEvent>;
  /** Fired when a fenced code block is tapped. Receives its code and language. */
  onCodeBlockPress?: CodegenTypes.BubblingEventHandler<CodeBlockPressEvent>;
  /**
   * Gates native code block tap handling; set to `true` by the JS wrapper when
   * `onCodeBlockPress` is provided.
   * @default false
   */
  enableCodeBlockPress?: CodegenTypes.WithDefault<boolean, false>;
  /**
   * Callback fired when a math expression cannot be parsed or rendered by the
   * LaTeX engine. Receives the raw LaTeX `source` of the failing inline span or
   * block (no delimiters), the engine's error `message` (empty when none), and
   * `displayMode` (false = inline `$...$`, true = block `$$...$$`). The whole
   * expression is the unit of failure; the engine does not report a single
   * offending command.
   */
  onLatexError?: CodegenTypes.BubblingEventHandler<LatexErrorEvent>;
  /**
   * Controls the long-press copy menu on code blocks, tables, block math, and blockquotes/admonitions.
   * @default true
   */
  enableBlockContextMenu?: CodegenTypes.WithDefault<boolean, true>;
  /**
   * Controls whether the system link preview is shown on long press (iOS only).
   *
   * When `true` (default), long-pressing a link shows the native iOS link preview.
   * When `false`, the system preview is suppressed.
   *
   * Automatically set to `false` when `onLinkLongPress` is provided (unless explicitly overridden).
   *
   * Android: No-op (Android doesn't have a system link preview).
   *
   * @default true
   */
  enableLinkPreview?: CodegenTypes.WithDefault<boolean, true>;
  /**
   * - iOS: Controls text selection and link previews on long press.
   * - Android: Controls text selection.
   * @default true
   */
  selectable?: boolean;
  /**
   * Color of the text selection highlight.
   *
   * On iOS, this also affects the caret and selection handle colors
   * (they share a single tint). On macOS, only the selection background
   * is affected.
   *
   * @platform ios, android, macos, web
   */
  selectionColor?: ColorValue;
  /**
   * Color of the selection handles (drag anchors).
   * No-op on API levels below 29.
   *
   * @platform android
   */
  selectionHandleColor?: ColorValue;
  /**
   * MD4C parser flags configuration.
   * Controls how the markdown parser interprets certain syntax.
   */
  md4cFlags: Md4cFlagsInternal;
  /** Enables the GFM table, strikethrough, and task-list extensions. */
  isGFM?: CodegenTypes.WithDefault<boolean, false>;
  /**
   * Specifies whether fonts should scale to respect Text Size accessibility settings.
   * When false, text will not scale with the user's accessibility settings.
   * @default true
   */
  allowFontScaling?: CodegenTypes.WithDefault<boolean, true>;
  /**
   * Specifies the largest possible scale a font can reach when allowFontScaling is enabled.
   * Possible values:
   * - undefined/null (default): inherit from parent or global default (no limit)
   * - 0: no limit, ignore parent/global default
   * - >= 1: sets the maxFontSizeMultiplier of this node to this value
   * @default undefined
   */
  maxFontSizeMultiplier?: CodegenTypes.Float;
  /**
   * When false (default), removes trailing margin from the last element to eliminate bottom spacing.
   * When true, keeps the trailing margin from the last element's marginBottom style.
   * @default false
   */
  allowTrailingMargin?: CodegenTypes.WithDefault<boolean, false>;
  /**
   * When true, newly appended content fades in during streaming updates.
   * Only the tail (new characters beyond the previous content) is animated.
   * @default false
   */
  streamingAnimation?: CodegenTypes.WithDefault<boolean, false>;
  /**
   * Fine-grained control over streaming behavior for block-level elements.
   */
  streamingConfig?: StreamingConfigInternal;
  /**
   * Controls how spoiler text is displayed before being revealed.
   * - 'particles' (default): animated particle overlay.
   * - 'solid': opaque rectangle covering the text.
   * @default 'particles'
   */
  spoilerOverlay?: CodegenTypes.WithDefault<string, 'particles'>;
  /**
   * Custom items to show in the text selection context menu.
   */
  contextMenuItems?: ReadonlyArray<Readonly<ContextMenuItemConfig>>;
  /**
   * HTTP headers attached to remote image requests, as name/value pairs.
   */
  imageRequestHeaders?: ReadonlyArray<Readonly<ImageRequestHeaderInternal>>;
  /** Per-link pill content (label, icon), one entry per exact link URL. */
  linkPillContent?: ReadonlyArray<Readonly<LinkPillContentInternal>>;
  /** Opt-in text link recognition; see `EnrichedMarkdownTextProps.linkRecognition`. */
  linkRecognition?: Readonly<{
    text: Readonly<TextLinkNativeRegex>;
    inlineCode: Readonly<TextLinkNativeRegex>;
  }>;
  /** Link long-press menus (iOS 17+): item lists by URL pattern, in matching order. */
  linkContextMenuItems?: ReadonlyArray<Readonly<LinkContextMenuItemsConfig>>;
  onLinkContextMenuItemPress?: CodegenTypes.BubblingEventHandler<OnLinkContextMenuItemPressEvent>;
  /**
   * Built-in items to show in the text selection context menu.
   */
  selectionMenuConfig: Readonly<SelectionMenuConfig>;
  accessibilityLabels: Readonly<AccessibilityLabelsProps>;
  /**
   * Fired when a custom context menu item is pressed.
   * Receives the item label, the currently selected text, and the selection range.
   */
  onContextMenuItemPress?: CodegenTypes.BubblingEventHandler<OnContextMenuItemPressEvent>;
  /**
   * Sets the text break strategy on Android (API 23+).
   * @default 'highQuality'
   * @platform android
   */
  textBreakStrategy?: CodegenTypes.WithDefault<string, 'highQuality'>;
  /**
   * Sets the line break strategy on iOS 14+.
   * @default 'none'
   * @platform ios
   */
  lineBreakStrategyIOS?: CodegenTypes.WithDefault<string, 'none'>;
  /**
   * Paragraph writing direction.
   * - 'first-strong' (default): resolves each paragraph from its first strong directional character;
   *   neutral-only paragraphs fall back to the view's resolved layout direction. Library extension —
   *   matches Android's TEXT_DIRECTION_FIRST_STRONG.
   * - 'auto': React Native parity; iOS TextKit follows the app's userInterfaceLayoutDirection.
   * - 'ltr' / 'rtl': force base direction on every paragraph. Code blocks always stay LTR.
   * @default 'first-strong'
   * @platform ios
   */
  writingDirection?: CodegenTypes.WithDefault<string, 'first-strong'>;
  /**
   * Maximum number of lines to display before the text is truncated. 0 (the
   * default) means unlimited. Matches React Native Text's `numberOfLines`.
   * Only applies to CommonMark; ignored when the flavor is 'github'.
   * Android: while clamped the view is not selectable and links are not tappable
   * (DynamicLayout has no maxLines support, so selection/links would drop the
   * ellipsis); both are restored once the clamp is removed. iOS is unaffected.
   * @default 0
   */
  numberOfLines?: CodegenTypes.WithDefault<CodegenTypes.Int32, 0>;
  /**
   * Where to place the ellipsis when text is truncated by `numberOfLines`:
   * 'head' | 'middle' | 'tail' | 'clip' ('clip' cuts with no ellipsis). Only
   * takes effect when `numberOfLines` is set. Matches React Native Text's
   * `ellipsizeMode`. Ignored when the flavor is 'github'.
   * @default 'tail'
   */
  ellipsizeMode?: CodegenTypes.WithDefault<string, 'tail'>;
}

export default codegenNativeComponent<NativeProps>('EnrichedMarkdownText', {
  interfaceOnly: true,
});
