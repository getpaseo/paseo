export type BlockTextAlign = 'auto' | 'left' | 'right' | 'center' | 'justify';
export type EmphasisFontStyle = 'normal' | 'italic' | 'oblique' | '';
export type TableAlign = 'left' | 'center' | 'right' | '';
export type ImageResizeMode = 'contain' | 'cover' | 'stretch' | 'center' | 'none' | '';
interface BaseBlockStyleInternal {
    fontSize: number;
    fontFamily: string;
    fontWeight: string;
    color: string;
    marginTop: number;
    marginBottom: number;
    lineHeight: number;
}
interface ParagraphStyleInternal extends BaseBlockStyleInternal {
    textAlign: BlockTextAlign;
}
interface HeadingStyleInternal extends BaseBlockStyleInternal {
    textAlign: BlockTextAlign;
}
export interface AdmonitionColorsInternal {
    color: string;
    backgroundColor: string;
}
export interface AdmonitionsStyleInternal {
    note: AdmonitionColorsInternal;
    tip: AdmonitionColorsInternal;
    important: AdmonitionColorsInternal;
    warning: AdmonitionColorsInternal;
    caution: AdmonitionColorsInternal;
}
interface BlockquoteStyleInternal extends BaseBlockStyleInternal {
    borderColor: string;
    borderWidth: number;
    gapWidth: number;
    backgroundColor: string;
    borderRadius: number;
    padding: number;
    admonitions: AdmonitionsStyleInternal;
}
interface ListStyleInternal extends BaseBlockStyleInternal {
    bulletColor: string;
    bulletSize: number;
    markerMinWidth: number;
    markerColor: string;
    markerFontWeight: string;
    gapWidth: number;
    marginLeft: number;
    itemSpacing: number;
}
export interface CodeBlockSyntaxColorsInternal {
    keyword: string;
    operatorColor: string;
    punctuation: string;
    string: string;
    number: string;
    constant: string;
    comment: string;
    function: string;
    type: string;
    variable: string;
    property: string;
    tag: string;
    attribute: string;
    embedded: string;
}
interface CodeBlockStyleInternal extends BaseBlockStyleInternal {
    backgroundColor: string;
    borderColor: string;
    borderRadius: number;
    borderWidth: number;
    padding: number;
    syntaxColors: CodeBlockSyntaxColorsInternal;
}
interface LinkStyleInternal {
    fontFamily: string;
    color: string;
    underline: boolean;
    backgroundColor: string;
}
export interface LinkVariantEntryInternal {
    pattern: string;
    color: string;
    underline: boolean;
    backgroundColor: string;
    fontFamily: string;
    pill: LinkPillInternal;
}
export interface LinkPillInternal {
    enabled: boolean;
    label: string;
    iconUri: string;
    iconTintColor?: string;
    borderRadius: number;
    paddingHorizontal: number;
    paddingVertical: number;
    lineHeight: number;
    borderWidth: number;
    borderColor: string;
    maxWidth: number;
}
interface StrongStyleInternal {
    fontFamily: string;
    fontWeight: string;
    color?: string;
}
interface EmphasisStyleInternal {
    fontFamily: string;
    fontStyle: EmphasisFontStyle;
    color?: string;
}
interface StrikethroughStyleInternal {
    color: string;
}
interface UnderlineStyleInternal {
    color: string;
}
interface CodeStyleInternal {
    fontFamily: string;
    fontSize: number;
    fontScale: number;
    color: string;
    backgroundColor: string;
    borderColor: string;
}
interface ImageStyleInternal {
    height: number;
    maxHeight: number;
    aspectRatio: number;
    resizeMode: ImageResizeMode;
    borderRadius: number;
    marginTop: number;
    marginBottom: number;
}
interface VideoStyleInternal {
    marginTop: number;
    marginBottom: number;
    borderRadius: number;
    aspectRatio: number;
    backgroundColor: string;
}
interface InlineImageStyleInternal {
    size: number;
}
interface ThematicBreakStyleInternal {
    color: string;
    height: number;
    marginTop: number;
    marginBottom: number;
}
interface TableStyleInternal extends BaseBlockStyleInternal {
    headerFontFamily: string;
    headerBackgroundColor: string;
    headerTextColor: string;
    rowEvenBackgroundColor: string;
    rowOddBackgroundColor: string;
    borderColor: string;
    borderWidth: number;
    borderRadius: number;
    cellPaddingHorizontal: number;
    cellPaddingVertical: number;
    horizontalOverflow: number;
    align: TableAlign;
}
interface TaskListStyleInternal {
    checkedColor: string;
    borderColor: string;
    checkboxSize: number;
    checkboxBorderRadius: number;
    checkmarkColor: string;
    checkedTextColor: string;
    checkedStrikethrough: boolean;
}
interface MathStyleInternal {
    fontSize: number;
    color: string;
    backgroundColor: string;
    padding: number;
    marginTop: number;
    marginBottom: number;
    textAlign: BlockTextAlign;
}
interface InlineMathStyleInternal {
    color: string;
}
interface SpoilerParticlesStyleInternal {
    density: number;
    speed: number;
}
interface SpoilerSolidStyleInternal {
    borderRadius: number;
}
interface SpoilerStyleInternal {
    color: string;
    particles: SpoilerParticlesStyleInternal;
    solid: SpoilerSolidStyleInternal;
}
interface SuperscriptStyleInternal {
    fontScale: number;
    baselineOffsetScale: number;
}
interface SubscriptStyleInternal {
    fontScale: number;
    baselineOffsetScale: number;
}
interface HighlightStyleInternal {
    color: string;
    backgroundColor: string;
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
export {};
//# sourceMappingURL=MarkdownStyleInternal.d.ts.map