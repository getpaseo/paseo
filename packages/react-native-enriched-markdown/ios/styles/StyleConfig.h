#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

/// Pill presentation of a link variant: geometry plus the variant-wide default label and icon.
@interface LinkPillConfig : NSObject
@property (nonatomic, copy) NSString *label;
@property (nonatomic, copy) NSString *iconUri;
/// Nil keeps the icon's own colors.
@property (nonatomic, strong, nullable) RCTUIColor *iconTintColor;
@property (nonatomic, assign) CGFloat borderRadius;
@property (nonatomic, assign) CGFloat paddingHorizontal;
@property (nonatomic, assign) CGFloat paddingVertical;
/// Minimum line height of a block that holds the pill; 0 when unset.
@property (nonatomic, assign) CGFloat lineHeight;
@property (nonatomic, assign) CGFloat borderWidth;
@property (nonatomic, strong) RCTUIColor *borderColor;
@property (nonatomic, assign) CGFloat maxWidth;
@end

/// What one specific link's pill shows (the `linkPillContent` prop), keyed by exact URL.
@interface LinkPillContent : NSObject
@property (nonatomic, copy) NSString *label;
@property (nonatomic, copy) NSString *iconUri;
/// Tint for this link's icon; nil means none was set for the link.
@property (nonatomic, strong, nullable) RCTUIColor *iconTintColor;
@end

/**
 * Resolved style for a single URL-pattern variant (e.g. "^user:", "^channel:", "app\\.example\\.com/user/").
 * The `pattern` field is a regex tested against the full URL in normalized order.
 * Populated from the JS `linkVariants` map by StylePropsUtils and consumed by LinkRenderer.
 */
@interface LinkVariantConfig : NSObject
@property (nonatomic, copy) NSString *fontFamily;
/// Pill presentation for links matching this variant; nil when disabled.
@property (nonatomic, strong, nullable) LinkPillConfig *pill;
@property (nonatomic, copy) NSString *pattern;
@property (nonatomic, strong) RCTUIColor *color;
@property (nonatomic, assign) BOOL underline;
@property (nonatomic, strong, nullable) RCTUIColor *backgroundColor;
@end

@interface StyleConfig : NSObject <NSCopying>
- (instancetype)init;
- (CGFloat)fontScaleMultiplier;
/// `pill.lineHeight`, scaled with the font like the blocks' own line heights.
- (CGFloat)lineHeightForLinkPill:(LinkPillConfig *)pill;
- (void)setFontScaleMultiplier:(CGFloat)newValue;
- (CGFloat)maxFontSizeMultiplier;
- (void)setMaxFontSizeMultiplier:(CGFloat)newValue;
// Primary font properties
- (RCTUIColor *)primaryColor;
- (void)setPrimaryColor:(RCTUIColor *)newValue;
- (NSNumber *)primaryFontSize;
- (void)setPrimaryFontSize:(NSNumber *)newValue;
- (NSString *)primaryFontWeight;
- (void)setPrimaryFontWeight:(NSString *)newValue;
- (NSString *)primaryFontFamily;
- (void)setPrimaryFontFamily:(NSString *)newValue;
- (UIFont *)primaryFont;
// Paragraph properties
- (CGFloat)paragraphFontSize;
- (void)setParagraphFontSize:(CGFloat)newValue;
- (NSString *)paragraphFontFamily;
- (void)setParagraphFontFamily:(NSString *)newValue;
- (NSString *)paragraphFontWeight;
- (void)setParagraphFontWeight:(NSString *)newValue;
- (RCTUIColor *)paragraphColor;
- (void)setParagraphColor:(RCTUIColor *)newValue;
- (CGFloat)paragraphMarginTop;
- (void)setParagraphMarginTop:(CGFloat)newValue;
- (CGFloat)paragraphMarginBottom;
- (void)setParagraphMarginBottom:(CGFloat)newValue;
- (CGFloat)paragraphLineHeight;
- (void)setParagraphLineHeight:(CGFloat)newValue;
- (NSTextAlignment)paragraphTextAlign;
- (void)setParagraphTextAlign:(NSTextAlignment)newValue;
- (UIFont *)paragraphFont;
// H1 properties
- (CGFloat)h1FontSize;
- (void)setH1FontSize:(CGFloat)newValue;
- (NSString *)h1FontFamily;
- (void)setH1FontFamily:(NSString *)newValue;
- (NSString *)h1FontWeight;
- (void)setH1FontWeight:(NSString *)newValue;
- (RCTUIColor *)h1Color;
- (void)setH1Color:(RCTUIColor *)newValue;
- (CGFloat)h1MarginTop;
- (void)setH1MarginTop:(CGFloat)newValue;
- (CGFloat)h1MarginBottom;
- (void)setH1MarginBottom:(CGFloat)newValue;
- (CGFloat)h1LineHeight;
- (void)setH1LineHeight:(CGFloat)newValue;
- (NSTextAlignment)h1TextAlign;
- (void)setH1TextAlign:(NSTextAlignment)newValue;
- (UIFont *)h1Font;
// H2 properties
- (CGFloat)h2FontSize;
- (void)setH2FontSize:(CGFloat)newValue;
- (NSString *)h2FontFamily;
- (void)setH2FontFamily:(NSString *)newValue;
- (NSString *)h2FontWeight;
- (void)setH2FontWeight:(NSString *)newValue;
- (RCTUIColor *)h2Color;
- (void)setH2Color:(RCTUIColor *)newValue;
- (CGFloat)h2MarginTop;
- (void)setH2MarginTop:(CGFloat)newValue;
- (CGFloat)h2MarginBottom;
- (void)setH2MarginBottom:(CGFloat)newValue;
- (CGFloat)h2LineHeight;
- (void)setH2LineHeight:(CGFloat)newValue;
- (NSTextAlignment)h2TextAlign;
- (void)setH2TextAlign:(NSTextAlignment)newValue;
- (UIFont *)h2Font;
// H3 properties
- (CGFloat)h3FontSize;
- (void)setH3FontSize:(CGFloat)newValue;
- (NSString *)h3FontFamily;
- (void)setH3FontFamily:(NSString *)newValue;
- (NSString *)h3FontWeight;
- (void)setH3FontWeight:(NSString *)newValue;
- (RCTUIColor *)h3Color;
- (void)setH3Color:(RCTUIColor *)newValue;
- (CGFloat)h3MarginTop;
- (void)setH3MarginTop:(CGFloat)newValue;
- (CGFloat)h3MarginBottom;
- (void)setH3MarginBottom:(CGFloat)newValue;
- (CGFloat)h3LineHeight;
- (void)setH3LineHeight:(CGFloat)newValue;
- (NSTextAlignment)h3TextAlign;
- (void)setH3TextAlign:(NSTextAlignment)newValue;
- (UIFont *)h3Font;
// H4 properties
- (CGFloat)h4FontSize;
- (void)setH4FontSize:(CGFloat)newValue;
- (NSString *)h4FontFamily;
- (void)setH4FontFamily:(NSString *)newValue;
- (NSString *)h4FontWeight;
- (void)setH4FontWeight:(NSString *)newValue;
- (RCTUIColor *)h4Color;
- (void)setH4Color:(RCTUIColor *)newValue;
- (CGFloat)h4MarginTop;
- (void)setH4MarginTop:(CGFloat)newValue;
- (CGFloat)h4MarginBottom;
- (void)setH4MarginBottom:(CGFloat)newValue;
- (CGFloat)h4LineHeight;
- (void)setH4LineHeight:(CGFloat)newValue;
- (NSTextAlignment)h4TextAlign;
- (void)setH4TextAlign:(NSTextAlignment)newValue;
- (UIFont *)h4Font;
// H5 properties
- (CGFloat)h5FontSize;
- (void)setH5FontSize:(CGFloat)newValue;
- (NSString *)h5FontFamily;
- (void)setH5FontFamily:(NSString *)newValue;
- (NSString *)h5FontWeight;
- (void)setH5FontWeight:(NSString *)newValue;
- (RCTUIColor *)h5Color;
- (void)setH5Color:(RCTUIColor *)newValue;
- (CGFloat)h5MarginTop;
- (void)setH5MarginTop:(CGFloat)newValue;
- (CGFloat)h5MarginBottom;
- (void)setH5MarginBottom:(CGFloat)newValue;
- (CGFloat)h5LineHeight;
- (void)setH5LineHeight:(CGFloat)newValue;
- (NSTextAlignment)h5TextAlign;
- (void)setH5TextAlign:(NSTextAlignment)newValue;
- (UIFont *)h5Font;
// H6 properties
- (CGFloat)h6FontSize;
- (void)setH6FontSize:(CGFloat)newValue;
- (NSString *)h6FontFamily;
- (void)setH6FontFamily:(NSString *)newValue;
- (NSString *)h6FontWeight;
- (void)setH6FontWeight:(NSString *)newValue;
- (RCTUIColor *)h6Color;
- (void)setH6Color:(RCTUIColor *)newValue;
- (CGFloat)h6MarginTop;
- (void)setH6MarginTop:(CGFloat)newValue;
- (CGFloat)h6MarginBottom;
- (void)setH6MarginBottom:(CGFloat)newValue;
- (CGFloat)h6LineHeight;
- (void)setH6LineHeight:(CGFloat)newValue;
- (NSTextAlignment)h6TextAlign;
- (void)setH6TextAlign:(NSTextAlignment)newValue;
- (UIFont *)h6Font;
// Link properties
- (NSString *)linkFontFamily;
- (void)setLinkFontFamily:(NSString *)newValue;
- (RCTUIColor *)linkColor;
- (void)setLinkColor:(RCTUIColor *)newValue;
- (BOOL)linkUnderline;
- (void)setLinkUnderline:(BOOL)newValue;
- (nullable RCTUIColor *)linkBackgroundColor;
- (void)setLinkBackgroundColor:(nullable RCTUIColor *)newValue;
- (NSArray<LinkVariantConfig *> *)linkVariants;
- (void)setLinkVariants:(NSArray<LinkVariantConfig *> *)newValue;
- (nullable LinkVariantConfig *)effectiveLinkVariantForURL:(NSString *)url;
// Strong properties
- (NSString *)strongFontFamily;
- (void)setStrongFontFamily:(NSString *)newValue;
- (NSString *)strongFontWeight;
- (void)setStrongFontWeight:(NSString *)newValue;
- (RCTUIColor *)strongColor;
- (void)setStrongColor:(RCTUIColor *)newValue;
// Emphasis properties
- (NSString *)emphasisFontFamily;
- (void)setEmphasisFontFamily:(NSString *)newValue;
- (NSString *)emphasisFontStyle;
- (void)setEmphasisFontStyle:(NSString *)newValue;
- (RCTUIColor *)emphasisColor;
- (void)setEmphasisColor:(RCTUIColor *)newValue;
// Strikethrough properties
- (RCTUIColor *)strikethroughColor;
- (void)setStrikethroughColor:(RCTUIColor *)newValue;
// Highlight properties
- (nullable RCTUIColor *)highlightColor;
- (void)setHighlightColor:(nullable RCTUIColor *)newValue;
- (nullable RCTUIColor *)highlightBackgroundColor;
- (void)setHighlightBackgroundColor:(nullable RCTUIColor *)newValue;
// Underline properties
- (RCTUIColor *)underlineColor;
- (void)setUnderlineColor:(RCTUIColor *)newValue;
// Code properties
- (NSString *)codeFontFamily;
- (void)setCodeFontFamily:(NSString *)newValue;
- (CGFloat)codeFontScale;
- (void)setCodeFontScale:(CGFloat)newValue;
- (CGFloat)codeFontSize;
- (void)setCodeFontSize:(CGFloat)newValue;
- (RCTUIColor *)codeColor;
- (void)setCodeColor:(RCTUIColor *)newValue;
- (RCTUIColor *)codeBackgroundColor;
- (void)setCodeBackgroundColor:(RCTUIColor *)newValue;
- (RCTUIColor *)codeBorderColor;
- (void)setCodeBorderColor:(RCTUIColor *)newValue;
// Image properties
- (CGFloat)imageHeight;
- (void)setImageHeight:(CGFloat)newValue;
- (CGFloat)imageMaxHeight;
- (void)setImageMaxHeight:(CGFloat)newValue;
- (CGFloat)imageAspectRatio;
- (void)setImageAspectRatio:(CGFloat)newValue;
- (NSString *)imageResizeMode;
- (void)setImageResizeMode:(NSString *)newValue;
- (CGFloat)imageBorderRadius;
- (void)setImageBorderRadius:(CGFloat)newValue;
- (CGFloat)imageMarginTop;
- (void)setImageMarginTop:(CGFloat)newValue;
- (CGFloat)imageMarginBottom;
- (void)setImageMarginBottom:(CGFloat)newValue;
- (nullable NSDictionary<NSString *, NSString *> *)imageRequestHeaders;
- (void)setImageRequestHeaders:(nullable NSDictionary<NSString *, NSString *> *)newValue;
// Per-link pill content, keyed by exact URL
- (nullable NSDictionary<NSString *, LinkPillContent *> *)linkPillContent;
- (void)setLinkPillContent:(nullable NSDictionary<NSString *, LinkPillContent *> *)newValue;
// Video properties
- (CGFloat)videoMarginTop;
- (void)setVideoMarginTop:(CGFloat)newValue;
- (CGFloat)videoMarginBottom;
- (void)setVideoMarginBottom:(CGFloat)newValue;
- (CGFloat)videoBorderRadius;
- (void)setVideoBorderRadius:(CGFloat)newValue;
- (CGFloat)videoAspectRatio;
- (void)setVideoAspectRatio:(CGFloat)newValue;
- (RCTUIColor *)videoBackgroundColor;
- (void)setVideoBackgroundColor:(RCTUIColor *)newValue;
// Inline image properties
- (CGFloat)inlineImageSize;
- (void)setInlineImageSize:(CGFloat)newValue;
// Blockquote properties
- (CGFloat)blockquoteFontSize;
- (void)setBlockquoteFontSize:(CGFloat)newValue;
- (NSString *)blockquoteFontFamily;
- (void)setBlockquoteFontFamily:(NSString *)newValue;
- (NSString *)blockquoteFontWeight;
- (void)setBlockquoteFontWeight:(NSString *)newValue;
- (RCTUIColor *)blockquoteColor;
- (void)setBlockquoteColor:(RCTUIColor *)newValue;
- (CGFloat)blockquoteMarginTop;
- (void)setBlockquoteMarginTop:(CGFloat)newValue;
- (CGFloat)blockquoteMarginBottom;
- (void)setBlockquoteMarginBottom:(CGFloat)newValue;
- (CGFloat)blockquoteLineHeight;
- (void)setBlockquoteLineHeight:(CGFloat)newValue;
- (UIFont *)blockquoteFont;
- (RCTUIColor *)blockquoteBorderColor;
- (void)setBlockquoteBorderColor:(RCTUIColor *)newValue;
- (CGFloat)blockquoteBorderWidth;
- (void)setBlockquoteBorderWidth:(CGFloat)newValue;
- (CGFloat)blockquoteGapWidth;
- (void)setBlockquoteGapWidth:(CGFloat)newValue;
- (RCTUIColor *)blockquoteBackgroundColor;
- (void)setBlockquoteBackgroundColor:(RCTUIColor *)newValue;
- (CGFloat)blockquoteBorderRadius;
- (void)setBlockquoteBorderRadius:(CGFloat)newValue;
- (CGFloat)blockquotePadding;
- (void)setBlockquotePadding:(CGFloat)newValue;
// Per-admonition-type colors (keyed by "note"/"tip"/"important"/"warning"/"caution").
- (void)setAdmonitionColors:(NSDictionary<NSString *, RCTUIColor *> *)colors
           backgroundColors:(NSDictionary<NSString *, RCTUIColor *> *)backgroundColors;
- (RCTUIColor *)admonitionColorForType:(NSString *)type;
- (RCTUIColor *)admonitionBackgroundColorForType:(NSString *)type;
// List style properties (combined for both ordered and unordered lists)
- (CGFloat)listStyleFontSize;
- (void)setListStyleFontSize:(CGFloat)newValue;
- (NSString *)listStyleFontFamily;
- (void)setListStyleFontFamily:(NSString *)newValue;
- (NSString *)listStyleFontWeight;
- (void)setListStyleFontWeight:(NSString *)newValue;
- (RCTUIColor *)listStyleColor;
- (void)setListStyleColor:(RCTUIColor *)newValue;
- (CGFloat)listStyleMarginTop;
- (void)setListStyleMarginTop:(CGFloat)newValue;
- (CGFloat)listStyleMarginBottom;
- (void)setListStyleMarginBottom:(CGFloat)newValue;
- (CGFloat)listStyleLineHeight;
- (void)setListStyleLineHeight:(CGFloat)newValue;
- (RCTUIColor *)listStyleBulletColor;
- (void)setListStyleBulletColor:(RCTUIColor *)newValue;
- (CGFloat)listStyleBulletSize;
- (void)setListStyleBulletSize:(CGFloat)newValue;
- (CGFloat)listStyleMarkerMinWidth;
- (void)setListStyleMarkerMinWidth:(CGFloat)newValue;
- (RCTUIColor *)listStyleMarkerColor;
- (void)setListStyleMarkerColor:(RCTUIColor *)newValue;
- (NSString *)listStyleMarkerFontWeight;
- (void)setListStyleMarkerFontWeight:(NSString *)newValue;
- (CGFloat)listStyleGapWidth;
- (void)setListStyleGapWidth:(CGFloat)newValue;
- (CGFloat)listStyleMarginLeft;
- (void)setListStyleMarginLeft:(CGFloat)newValue;
- (CGFloat)listStyleItemSpacing;
- (void)setListStyleItemSpacing:(CGFloat)newValue;
- (UIFont *)listMarkerFont;
- (UIFont *)listStyleFont;
- (CGFloat)effectiveListGapWidth;
- (CGFloat)effectiveListMarginLeftForBullet;
- (CGFloat)effectiveListMarginLeftForNumber;
- (CGFloat)effectiveListMarginLeftForTask;
// Code block properties
- (CGFloat)codeBlockFontSize;
- (void)setCodeBlockFontSize:(CGFloat)newValue;
- (NSString *)codeBlockFontFamily;
- (void)setCodeBlockFontFamily:(NSString *)newValue;
- (NSString *)codeBlockFontWeight;
- (void)setCodeBlockFontWeight:(NSString *)newValue;
- (RCTUIColor *)codeBlockColor;
- (void)setCodeBlockColor:(RCTUIColor *)newValue;
- (CGFloat)codeBlockMarginTop;
- (void)setCodeBlockMarginTop:(CGFloat)newValue;
- (CGFloat)codeBlockMarginBottom;
- (void)setCodeBlockMarginBottom:(CGFloat)newValue;
- (CGFloat)codeBlockLineHeight;
- (void)setCodeBlockLineHeight:(CGFloat)newValue;
- (RCTUIColor *)codeBlockBackgroundColor;
- (void)setCodeBlockBackgroundColor:(RCTUIColor *)newValue;
- (RCTUIColor *)codeBlockBorderColor;
- (void)setCodeBlockBorderColor:(RCTUIColor *)newValue;
- (CGFloat)codeBlockBorderRadius;
- (void)setCodeBlockBorderRadius:(CGFloat)newValue;
- (CGFloat)codeBlockBorderWidth;
- (void)setCodeBlockBorderWidth:(CGFloat)newValue;
- (CGFloat)codeBlockPadding;
- (void)setCodeBlockPadding:(CGFloat)newValue;
- (UIFont *)codeBlockFont;
// Syntax highlight colors, indexed by HighlightTokenType ordinal. Resolved on
// the JS side; the getter returns a cached color with no allocation.
- (RCTUIColor *_Nullable)codeBlockSyntaxColorForToken:(NSInteger)tokenType;
- (void)setCodeBlockSyntaxColor:(RCTUIColor *)newValue forToken:(NSInteger)tokenType;
// Thematic break properties
- (RCTUIColor *)thematicBreakColor;
- (void)setThematicBreakColor:(RCTUIColor *)newValue;
- (CGFloat)thematicBreakHeight;
- (void)setThematicBreakHeight:(CGFloat)newValue;
- (CGFloat)thematicBreakMarginTop;
- (void)setThematicBreakMarginTop:(CGFloat)newValue;
- (CGFloat)thematicBreakMarginBottom;
- (void)setThematicBreakMarginBottom:(CGFloat)newValue;
// Table properties
- (CGFloat)tableFontSize;
- (void)setTableFontSize:(CGFloat)newValue;
- (NSString *)tableFontFamily;
- (void)setTableFontFamily:(NSString *)newValue;
- (NSString *)tableFontWeight;
- (void)setTableFontWeight:(NSString *)newValue;
- (RCTUIColor *)tableColor;
- (void)setTableColor:(RCTUIColor *)newValue;
- (CGFloat)tableMarginTop;
- (void)setTableMarginTop:(CGFloat)newValue;
- (CGFloat)tableMarginBottom;
- (void)setTableMarginBottom:(CGFloat)newValue;
- (CGFloat)tableLineHeight;
- (void)setTableLineHeight:(CGFloat)newValue;
- (UIFont *)tableFont;
- (NSString *)tableHeaderFontFamily;
- (void)setTableHeaderFontFamily:(NSString *)newValue;
- (UIFont *)tableHeaderFont;
- (RCTUIColor *)tableHeaderBackgroundColor;
- (void)setTableHeaderBackgroundColor:(RCTUIColor *)newValue;
- (RCTUIColor *)tableHeaderTextColor;
- (void)setTableHeaderTextColor:(RCTUIColor *)newValue;
- (RCTUIColor *)tableRowEvenBackgroundColor;
- (void)setTableRowEvenBackgroundColor:(RCTUIColor *)newValue;
- (RCTUIColor *)tableRowOddBackgroundColor;
- (void)setTableRowOddBackgroundColor:(RCTUIColor *)newValue;
- (RCTUIColor *)tableBorderColor;
- (void)setTableBorderColor:(RCTUIColor *)newValue;
- (CGFloat)tableBorderWidth;
- (void)setTableBorderWidth:(CGFloat)newValue;
- (CGFloat)tableBorderRadius;
- (void)setTableBorderRadius:(CGFloat)newValue;
- (CGFloat)tableCellPaddingHorizontal;
- (void)setTableCellPaddingHorizontal:(CGFloat)newValue;
- (CGFloat)tableCellPaddingVertical;
- (void)setTableCellPaddingVertical:(CGFloat)newValue;
- (CGFloat)tableHorizontalOverflow;
- (void)setTableHorizontalOverflow:(CGFloat)newValue;
- (NSString *)tableAlign;
- (void)setTableAlign:(NSString *)newValue;
// Task list checkbox properties
- (RCTUIColor *)taskListCheckedColor;
- (void)setTaskListCheckedColor:(RCTUIColor *)newValue;
- (RCTUIColor *)taskListBorderColor;
- (void)setTaskListBorderColor:(RCTUIColor *)newValue;
- (CGFloat)taskListCheckboxSize;
- (void)setTaskListCheckboxSize:(CGFloat)newValue;
- (CGFloat)taskListCheckboxBorderRadius;
- (void)setTaskListCheckboxBorderRadius:(CGFloat)newValue;
- (RCTUIColor *)taskListCheckmarkColor;
- (void)setTaskListCheckmarkColor:(RCTUIColor *)newValue;
- (RCTUIColor *)taskListCheckedTextColor;
- (void)setTaskListCheckedTextColor:(RCTUIColor *)newValue;
- (BOOL)taskListCheckedStrikethrough;
- (void)setTaskListCheckedStrikethrough:(BOOL)newValue;
// Math properties
- (CGFloat)mathFontSize;
- (void)setMathFontSize:(CGFloat)newValue;
- (RCTUIColor *)mathColor;
- (void)setMathColor:(RCTUIColor *)newValue;
- (RCTUIColor *)mathBackgroundColor;
- (void)setMathBackgroundColor:(RCTUIColor *)newValue;
- (CGFloat)mathPadding;
- (void)setMathPadding:(CGFloat)newValue;
- (CGFloat)mathMarginTop;
- (void)setMathMarginTop:(CGFloat)newValue;
- (CGFloat)mathMarginBottom;
- (void)setMathMarginBottom:(CGFloat)newValue;
- (NSString *)mathTextAlign;
- (void)setMathTextAlign:(NSString *)newValue;

// Inline Math properties
- (RCTUIColor *)inlineMathColor;
- (void)setInlineMathColor:(RCTUIColor *)newValue;
// Spoiler properties
- (RCTUIColor *)spoilerColor;
- (void)setSpoilerColor:(RCTUIColor *)newValue;
- (CGFloat)spoilerParticleDensity;
- (void)setSpoilerParticleDensity:(CGFloat)newValue;
- (CGFloat)spoilerParticleSpeed;
- (void)setSpoilerParticleSpeed:(CGFloat)newValue;
- (CGFloat)spoilerSolidBorderRadius;
- (void)setSpoilerSolidBorderRadius:(CGFloat)newValue;
// Superscript properties
- (CGFloat)superscriptFontScale;
- (void)setSuperscriptFontScale:(CGFloat)newValue;
- (CGFloat)superscriptBaselineOffsetScale;
- (void)setSuperscriptBaselineOffsetScale:(CGFloat)newValue;
// Subscript properties
- (CGFloat)subscriptFontScale;
- (void)setSubscriptFontScale:(CGFloat)newValue;
- (CGFloat)subscriptBaselineOffsetScale;
- (void)setSubscriptBaselineOffsetScale:(CGFloat)newValue;

@end

NS_ASSUME_NONNULL_END
