#import "StyleConfig.h"
#include "CodeBlockHighlighter.hpp"
#import "ENRMFontSlot.h"
#import "FontUtils.h"
#import <React/RCTFont.h>
#import <React/RCTUtils.h>

static const NSInteger kENRMCodeBlockSyntaxColorCount =
    static_cast<NSInteger>(Markdown::HighlightTokenType::Embedded) + 1;

static inline NSString *normalizedFontWeight(NSString *fontWeight)
{
  // If nil or empty string, return nil to let RCTFont use fontFamily as-is
  if (fontWeight == nil || fontWeight.length == 0) {
    return nil;
  }

  return fontWeight;
}

@implementation LinkPillConfig
@end

@implementation LinkPillContent
@end

@implementation LinkVariantConfig
@end

@interface LinkVariantRegexEntry : NSObject
@property (nonatomic, strong) NSRegularExpression *regex;
@property (nonatomic, strong) LinkVariantConfig *variant;
@end

@implementation LinkVariantRegexEntry
@end

@implementation StyleConfig {
  BOOL _allowFontScaling;
  CGFloat _maxFontSizeMultiplier;
  // Primary font properties
  RCTUIColor *_primaryColor;
  NSNumber *_primaryFontSize;
  NSString *_primaryFontWeight;
  NSString *_primaryFontFamily;
  ENRMFontSlot *_primaryFont;
  // Paragraph properties
  CGFloat _paragraphFontSize;
  NSString *_paragraphFontFamily;
  NSString *_paragraphFontWeight;
  RCTUIColor *_paragraphColor;
  CGFloat _paragraphMarginTop;
  CGFloat _paragraphMarginBottom;
  CGFloat _paragraphLineHeight;
  NSTextAlignment _paragraphTextAlign;
  ENRMFontSlot *_paragraphFont;
  // H1 properties
  CGFloat _h1FontSize;
  NSString *_h1FontFamily;
  NSString *_h1FontWeight;
  RCTUIColor *_h1Color;
  CGFloat _h1MarginTop;
  CGFloat _h1MarginBottom;
  CGFloat _h1LineHeight;
  NSTextAlignment _h1TextAlign;
  ENRMFontSlot *_h1Font;
  // H2 properties
  CGFloat _h2FontSize;
  NSString *_h2FontFamily;
  NSString *_h2FontWeight;
  RCTUIColor *_h2Color;
  CGFloat _h2MarginTop;
  CGFloat _h2MarginBottom;
  CGFloat _h2LineHeight;
  NSTextAlignment _h2TextAlign;
  ENRMFontSlot *_h2Font;
  // H3 properties
  CGFloat _h3FontSize;
  NSString *_h3FontFamily;
  NSString *_h3FontWeight;
  RCTUIColor *_h3Color;
  CGFloat _h3MarginTop;
  CGFloat _h3MarginBottom;
  CGFloat _h3LineHeight;
  NSTextAlignment _h3TextAlign;
  ENRMFontSlot *_h3Font;
  // H4 properties
  CGFloat _h4FontSize;
  NSString *_h4FontFamily;
  NSString *_h4FontWeight;
  RCTUIColor *_h4Color;
  CGFloat _h4MarginTop;
  CGFloat _h4MarginBottom;
  CGFloat _h4LineHeight;
  NSTextAlignment _h4TextAlign;
  ENRMFontSlot *_h4Font;
  // H5 properties
  CGFloat _h5FontSize;
  NSString *_h5FontFamily;
  NSString *_h5FontWeight;
  RCTUIColor *_h5Color;
  CGFloat _h5MarginTop;
  CGFloat _h5MarginBottom;
  CGFloat _h5LineHeight;
  NSTextAlignment _h5TextAlign;
  ENRMFontSlot *_h5Font;
  // H6 properties
  CGFloat _h6FontSize;
  NSString *_h6FontFamily;
  NSString *_h6FontWeight;
  RCTUIColor *_h6Color;
  CGFloat _h6MarginTop;
  CGFloat _h6MarginBottom;
  CGFloat _h6LineHeight;
  NSTextAlignment _h6TextAlign;
  ENRMFontSlot *_h6Font;
  // Link properties
  NSString *_linkFontFamily;
  RCTUIColor *_linkColor;
  BOOL _linkUnderline;
  RCTUIColor *_linkBackgroundColor;
  NSArray<LinkVariantConfig *> *_linkVariants;
  NSArray<LinkVariantRegexEntry *> *_compiledVariantRegexes;
  // Strong properties
  NSString *_strongFontFamily;
  NSString *_strongFontWeight;
  RCTUIColor *_strongColor;
  // Emphasis properties
  NSString *_emphasisFontFamily;
  NSString *_emphasisFontStyle;
  RCTUIColor *_emphasisColor;
  // Strikethrough properties
  RCTUIColor *_strikethroughColor;
  // Highlight properties
  RCTUIColor *_highlightColor;
  RCTUIColor *_highlightBackgroundColor;
  // Underline properties
  RCTUIColor *_underlineColor;
  // Code properties
  NSString *_codeFontFamily;
  CGFloat _codeFontSize;
  CGFloat _codeFontScale;
  RCTUIColor *_codeColor;
  RCTUIColor *_codeBackgroundColor;
  RCTUIColor *_codeBorderColor;
  // Image properties
  CGFloat _imageHeight;
  CGFloat _imageMaxHeight;
  CGFloat _imageAspectRatio;
  NSString *_imageResizeMode;
  CGFloat _imageBorderRadius;
  CGFloat _imageMarginTop;
  CGFloat _imageMarginBottom;
  NSDictionary<NSString *, NSString *> *_imageRequestHeaders;
  NSDictionary<NSString *, LinkPillContent *> *_linkPillContent;
  // Video properties
  CGFloat _videoMarginTop;
  CGFloat _videoMarginBottom;
  CGFloat _videoBorderRadius;
  CGFloat _videoAspectRatio;
  RCTUIColor *_videoBackgroundColor;
  // Inline image properties
  CGFloat _inlineImageSize;
  // Blockquote properties
  CGFloat _blockquoteFontSize;
  NSString *_blockquoteFontFamily;
  NSString *_blockquoteFontWeight;
  RCTUIColor *_blockquoteColor;
  CGFloat _blockquoteMarginTop;
  CGFloat _blockquoteMarginBottom;
  CGFloat _blockquoteLineHeight;
  RCTUIColor *_blockquoteBorderColor;
  CGFloat _blockquoteBorderWidth;
  CGFloat _blockquoteGapWidth;
  RCTUIColor *_blockquoteBackgroundColor;
  CGFloat _blockquoteBorderRadius;
  CGFloat _blockquotePadding;
  // Per-admonition-type colors keyed by type ("note"/"tip"/…). Empty until set.
  NSDictionary<NSString *, RCTUIColor *> *_admonitionColors;
  NSDictionary<NSString *, RCTUIColor *> *_admonitionBackgroundColors;
  ENRMFontSlot *_blockquoteFont;
  // List style properties (combined for both ordered and unordered lists)
  CGFloat _listStyleFontSize;
  NSString *_listStyleFontFamily;
  NSString *_listStyleFontWeight;
  RCTUIColor *_listStyleColor;
  CGFloat _listStyleMarginTop;
  CGFloat _listStyleMarginBottom;
  CGFloat _listStyleLineHeight;
  RCTUIColor *_listStyleBulletColor;
  CGFloat _listStyleBulletSize;
  CGFloat _listStyleMarkerMinWidth;
  RCTUIColor *_listStyleMarkerColor;
  NSString *_listStyleMarkerFontWeight;
  CGFloat _listStyleGapWidth;
  CGFloat _listStyleMarginLeft;
  CGFloat _listStyleItemSpacing;
  ENRMFontSlot *_listMarkerFont;
  ENRMFontSlot *_listStyleFont;
  // Code block properties
  CGFloat _codeBlockFontSize;
  NSString *_codeBlockFontFamily;
  NSString *_codeBlockFontWeight;
  RCTUIColor *_codeBlockColor;
  CGFloat _codeBlockMarginTop;
  CGFloat _codeBlockMarginBottom;
  CGFloat _codeBlockLineHeight;
  RCTUIColor *_codeBlockBackgroundColor;
  RCTUIColor *_codeBlockBorderColor;
  CGFloat _codeBlockBorderRadius;
  CGFloat _codeBlockBorderWidth;
  CGFloat _codeBlockPadding;
  RCTUIColor *_codeBlockSyntaxColors[kENRMCodeBlockSyntaxColorCount];
  ENRMFontSlot *_codeBlockFont;
  // Thematic break properties
  RCTUIColor *_thematicBreakColor;
  CGFloat _thematicBreakHeight;
  CGFloat _thematicBreakMarginTop;
  CGFloat _thematicBreakMarginBottom;
  // Table properties
  CGFloat _tableFontSize;
  NSString *_tableFontFamily;
  NSString *_tableFontWeight;
  RCTUIColor *_tableColor;
  CGFloat _tableMarginTop;
  CGFloat _tableMarginBottom;
  CGFloat _tableLineHeight;
  ENRMFontSlot *_tableFont;
  NSString *_tableHeaderFontFamily;
  ENRMFontSlot *_tableHeaderFont;
  RCTUIColor *_tableHeaderBackgroundColor;
  RCTUIColor *_tableHeaderTextColor;
  RCTUIColor *_tableRowEvenBackgroundColor;
  RCTUIColor *_tableRowOddBackgroundColor;
  RCTUIColor *_tableBorderColor;
  CGFloat _tableBorderWidth;
  CGFloat _tableBorderRadius;
  CGFloat _tableCellPaddingHorizontal;
  CGFloat _tableCellPaddingVertical;
  CGFloat _tableHorizontalOverflow;
  NSString *_tableAlign;
  // Task list checkbox
  RCTUIColor *_taskListCheckedColor;
  RCTUIColor *_taskListBorderColor;
  CGFloat _taskListCheckboxSize;
  CGFloat _taskListCheckboxBorderRadius;
  RCTUIColor *_taskListCheckmarkColor;
  RCTUIColor *_taskListCheckedTextColor;
  BOOL _taskListCheckedStrikethrough;
  // Math properties
  CGFloat _mathFontSize;
  RCTUIColor *_mathColor;
  RCTUIColor *_mathBackgroundColor;
  CGFloat _mathPadding;
  CGFloat _mathMarginTop;
  CGFloat _mathMarginBottom;
  NSString *_mathTextAlign;
  // Inline Math properties
  RCTUIColor *_inlineMathColor;
  // Spoiler properties
  RCTUIColor *_spoilerColor;
  CGFloat _spoilerParticleDensity;
  CGFloat _spoilerParticleSpeed;
  CGFloat _spoilerSolidBorderRadius;
  CGFloat _superscriptFontScale;
  CGFloat _superscriptBaselineOffsetScale;
  CGFloat _subscriptFontScale;
  CGFloat _subscriptBaselineOffsetScale;
  // All font cache entries — used for bulk invalidation
  NSArray<ENRMFontSlot *> *_allFontEntries;
}

- (instancetype)init
{
  self = [super init];
  _allowFontScaling = YES;
  _codeFontScale = 1;
  _maxFontSizeMultiplier = 0;
  _paragraphTextAlign = NSTextAlignmentNatural;
  _h1TextAlign = NSTextAlignmentNatural;
  _h2TextAlign = NSTextAlignmentNatural;
  _h3TextAlign = NSTextAlignmentNatural;
  _h4TextAlign = NSTextAlignmentNatural;
  _h5TextAlign = NSTextAlignmentNatural;
  _h6TextAlign = NSTextAlignmentNatural;
  _linkUnderline = YES;
  _linkVariants = @[];
  _compiledVariantRegexes = @[];
  _primaryFont = [[ENRMFontSlot alloc] init];
  _paragraphFont = [[ENRMFontSlot alloc] init];
  _h1Font = [[ENRMFontSlot alloc] init];
  _h2Font = [[ENRMFontSlot alloc] init];
  _h3Font = [[ENRMFontSlot alloc] init];
  _h4Font = [[ENRMFontSlot alloc] init];
  _h5Font = [[ENRMFontSlot alloc] init];
  _h6Font = [[ENRMFontSlot alloc] init];
  _listMarkerFont = [[ENRMFontSlot alloc] init];
  _listStyleFont = [[ENRMFontSlot alloc] init];
  _codeBlockFont = [[ENRMFontSlot alloc] init];
  _blockquoteFont = [[ENRMFontSlot alloc] init];
  _tableFont = [[ENRMFontSlot alloc] init];
  _tableHeaderFont = [[ENRMFontSlot alloc] init];
  _allFontEntries = @[
    _primaryFont, _paragraphFont, _h1Font, _h2Font, _h3Font, _h4Font, _h5Font, _h6Font, _listMarkerFont, _listStyleFont,
    _codeBlockFont, _blockquoteFont, _tableFont, _tableHeaderFont
  ];
  _admonitionColors = @{};
  _admonitionBackgroundColors = @{};
  return self;
}

- (void)invalidateAllFonts
{
  for (ENRMFontSlot *entry in _allFontEntries) {
    [entry invalidate];
  }
}

- (CGFloat)fontScaleMultiplier
{
  return _allowFontScaling ? RCTFontSizeMultiplier() : 1.0;
}

- (CGFloat)lineHeightForLinkPill:(LinkPillConfig *)pill
{
  if (_allowFontScaling && pill.lineHeight > 0) {
    return pill.lineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return pill.lineHeight;
}

- (void)setFontScaleMultiplier:(CGFloat)newValue
{
  BOOL newAllowFontScaling = (newValue != 1.0);
  if (_allowFontScaling != newAllowFontScaling) {
    _allowFontScaling = newAllowFontScaling;
    [self invalidateAllFonts];
  }
}

- (CGFloat)effectiveScaleMultiplierForFontSize:(CGFloat)fontSize
{
  if (!_allowFontScaling) {
    return 1.0;
  }
  return RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
}

- (CGFloat)maxFontSizeMultiplier
{
  return _maxFontSizeMultiplier;
}

- (void)setMaxFontSizeMultiplier:(CGFloat)newValue
{
  if (_maxFontSizeMultiplier != newValue) {
    _maxFontSizeMultiplier = newValue;
    [self invalidateAllFonts];
  }
}

- (id)copyWithZone:(NSZone *)zone
{
  // -init creates fresh ENRMFontSlot instances with needsRecreation = YES,
  // so all cached fonts will be rebuilt from the copied params below.
  StyleConfig *copy = [[[self class] allocWithZone:zone] init];
  copy->_allowFontScaling = _allowFontScaling;
  copy->_maxFontSizeMultiplier = _maxFontSizeMultiplier;
  copy->_primaryColor = [_primaryColor copy];
  copy->_primaryFontSize = [_primaryFontSize copy];
  copy->_primaryFontWeight = [_primaryFontWeight copy];
  copy->_primaryFontFamily = [_primaryFontFamily copy];
  copy->_paragraphFontSize = _paragraphFontSize;
  copy->_paragraphFontFamily = [_paragraphFontFamily copy];
  copy->_paragraphFontWeight = [_paragraphFontWeight copy];
  copy->_paragraphColor = [_paragraphColor copy];
  copy->_paragraphMarginTop = _paragraphMarginTop;
  copy->_paragraphMarginBottom = _paragraphMarginBottom;
  copy->_paragraphLineHeight = _paragraphLineHeight;
  copy->_paragraphTextAlign = _paragraphTextAlign;
  copy->_h1FontSize = _h1FontSize;
  copy->_h1FontFamily = [_h1FontFamily copy];
  copy->_h1FontWeight = [_h1FontWeight copy];
  copy->_h1Color = [_h1Color copy];
  copy->_h1MarginTop = _h1MarginTop;
  copy->_h1MarginBottom = _h1MarginBottom;
  copy->_h1LineHeight = _h1LineHeight;
  copy->_h1TextAlign = _h1TextAlign;
  copy->_h2FontSize = _h2FontSize;
  copy->_h2FontFamily = [_h2FontFamily copy];
  copy->_h2FontWeight = [_h2FontWeight copy];
  copy->_h2Color = [_h2Color copy];
  copy->_h2MarginTop = _h2MarginTop;
  copy->_h2MarginBottom = _h2MarginBottom;
  copy->_h2LineHeight = _h2LineHeight;
  copy->_h2TextAlign = _h2TextAlign;
  copy->_h3FontSize = _h3FontSize;
  copy->_h3FontFamily = [_h3FontFamily copy];
  copy->_h3FontWeight = [_h3FontWeight copy];
  copy->_h3Color = [_h3Color copy];
  copy->_h3MarginTop = _h3MarginTop;
  copy->_h3MarginBottom = _h3MarginBottom;
  copy->_h3LineHeight = _h3LineHeight;
  copy->_h3TextAlign = _h3TextAlign;
  copy->_h4FontSize = _h4FontSize;
  copy->_h4FontFamily = [_h4FontFamily copy];
  copy->_h4FontWeight = [_h4FontWeight copy];
  copy->_h4Color = [_h4Color copy];
  copy->_h4MarginTop = _h4MarginTop;
  copy->_h4MarginBottom = _h4MarginBottom;
  copy->_h4LineHeight = _h4LineHeight;
  copy->_h4TextAlign = _h4TextAlign;
  copy->_h5FontSize = _h5FontSize;
  copy->_h5FontFamily = [_h5FontFamily copy];
  copy->_h5FontWeight = [_h5FontWeight copy];
  copy->_h5Color = [_h5Color copy];
  copy->_h5MarginTop = _h5MarginTop;
  copy->_h5MarginBottom = _h5MarginBottom;
  copy->_h5LineHeight = _h5LineHeight;
  copy->_h5TextAlign = _h5TextAlign;
  copy->_h6FontSize = _h6FontSize;
  copy->_h6FontFamily = [_h6FontFamily copy];
  copy->_h6FontWeight = [_h6FontWeight copy];
  copy->_h6Color = [_h6Color copy];
  copy->_h6MarginTop = _h6MarginTop;
  copy->_h6MarginBottom = _h6MarginBottom;
  copy->_h6LineHeight = _h6LineHeight;
  copy->_h6TextAlign = _h6TextAlign;
  copy->_linkFontFamily = [_linkFontFamily copy];
  copy->_linkColor = [_linkColor copy];
  copy->_linkUnderline = _linkUnderline;
  copy->_linkBackgroundColor = [_linkBackgroundColor copy];
  copy->_linkVariants = [_linkVariants copy];
  copy->_compiledVariantRegexes = [_compiledVariantRegexes copy];
  copy->_strongFontFamily = [_strongFontFamily copy];
  copy->_strongFontWeight = [_strongFontWeight copy];
  copy->_strongColor = [_strongColor copy];
  copy->_emphasisFontFamily = [_emphasisFontFamily copy];
  copy->_emphasisFontStyle = [_emphasisFontStyle copy];
  copy->_emphasisColor = [_emphasisColor copy];
  copy->_strikethroughColor = [_strikethroughColor copy];
  copy->_highlightColor = [_highlightColor copy];
  copy->_highlightBackgroundColor = [_highlightBackgroundColor copy];
  copy->_underlineColor = [_underlineColor copy];
  copy->_codeFontFamily = [_codeFontFamily copy];
  copy->_codeFontSize = _codeFontSize;
  copy->_codeFontScale = _codeFontScale;
  copy->_codeColor = [_codeColor copy];
  copy->_codeBackgroundColor = [_codeBackgroundColor copy];
  copy->_codeBorderColor = [_codeBorderColor copy];
  copy->_imageHeight = _imageHeight;
  copy->_imageMaxHeight = _imageMaxHeight;
  copy->_imageAspectRatio = _imageAspectRatio;
  copy->_imageResizeMode = [_imageResizeMode copy];
  copy->_imageBorderRadius = _imageBorderRadius;
  copy->_imageMarginTop = _imageMarginTop;
  copy->_imageMarginBottom = _imageMarginBottom;
  copy->_imageRequestHeaders = [_imageRequestHeaders copy];
  copy->_linkPillContent = [_linkPillContent copy];
  copy->_videoMarginTop = _videoMarginTop;
  copy->_videoMarginBottom = _videoMarginBottom;
  copy->_videoBorderRadius = _videoBorderRadius;
  copy->_videoAspectRatio = _videoAspectRatio;
  copy->_videoBackgroundColor = [_videoBackgroundColor copy];
  copy->_inlineImageSize = _inlineImageSize;
  copy->_blockquoteFontSize = _blockquoteFontSize;
  copy->_blockquoteFontFamily = [_blockquoteFontFamily copy];
  copy->_blockquoteFontWeight = [_blockquoteFontWeight copy];
  copy->_blockquoteColor = [_blockquoteColor copy];
  copy->_blockquoteMarginTop = _blockquoteMarginTop;
  copy->_blockquoteMarginBottom = _blockquoteMarginBottom;
  copy->_blockquoteLineHeight = _blockquoteLineHeight;
  copy->_blockquoteBorderColor = [_blockquoteBorderColor copy];
  copy->_blockquoteBorderWidth = _blockquoteBorderWidth;
  copy->_blockquoteGapWidth = _blockquoteGapWidth;
  copy->_blockquoteBackgroundColor = [_blockquoteBackgroundColor copy];
  copy->_blockquoteBorderRadius = _blockquoteBorderRadius;
  copy->_blockquotePadding = _blockquotePadding;
  copy->_admonitionColors = [_admonitionColors copy];
  copy->_admonitionBackgroundColors = [_admonitionBackgroundColors copy];
  copy->_listStyleFontSize = _listStyleFontSize;
  copy->_listStyleFontFamily = [_listStyleFontFamily copy];
  copy->_listStyleFontWeight = [_listStyleFontWeight copy];
  copy->_listStyleColor = [_listStyleColor copy];
  copy->_listStyleMarginTop = _listStyleMarginTop;
  copy->_listStyleMarginBottom = _listStyleMarginBottom;
  copy->_listStyleLineHeight = _listStyleLineHeight;
  copy->_listStyleBulletColor = [_listStyleBulletColor copy];
  copy->_listStyleBulletSize = _listStyleBulletSize;
  copy->_listStyleMarkerMinWidth = _listStyleMarkerMinWidth;
  copy->_listStyleMarkerColor = [_listStyleMarkerColor copy];
  copy->_listStyleMarkerFontWeight = [_listStyleMarkerFontWeight copy];
  copy->_listStyleGapWidth = _listStyleGapWidth;
  copy->_listStyleMarginLeft = _listStyleMarginLeft;
  copy->_listStyleItemSpacing = _listStyleItemSpacing;
  copy->_codeBlockFontSize = _codeBlockFontSize;
  copy->_codeBlockFontFamily = [_codeBlockFontFamily copy];
  copy->_codeBlockFontWeight = [_codeBlockFontWeight copy];
  copy->_codeBlockColor = [_codeBlockColor copy];
  copy->_codeBlockMarginTop = _codeBlockMarginTop;
  copy->_codeBlockMarginBottom = _codeBlockMarginBottom;
  copy->_codeBlockLineHeight = _codeBlockLineHeight;
  copy->_codeBlockBackgroundColor = [_codeBlockBackgroundColor copy];
  copy->_codeBlockBorderColor = [_codeBlockBorderColor copy];
  copy->_codeBlockBorderRadius = _codeBlockBorderRadius;
  copy->_codeBlockBorderWidth = _codeBlockBorderWidth;
  copy->_codeBlockPadding = _codeBlockPadding;
  for (NSInteger i = 0; i < kENRMCodeBlockSyntaxColorCount; i++) {
    copy->_codeBlockSyntaxColors[i] = [_codeBlockSyntaxColors[i] copy];
  }
  copy->_thematicBreakColor = [_thematicBreakColor copy];
  copy->_thematicBreakHeight = _thematicBreakHeight;
  copy->_thematicBreakMarginTop = _thematicBreakMarginTop;
  copy->_thematicBreakMarginBottom = _thematicBreakMarginBottom;
  copy->_tableFontSize = _tableFontSize;
  copy->_tableFontFamily = [_tableFontFamily copy];
  copy->_tableFontWeight = [_tableFontWeight copy];
  copy->_tableColor = [_tableColor copy];
  copy->_tableMarginTop = _tableMarginTop;
  copy->_tableMarginBottom = _tableMarginBottom;
  copy->_tableLineHeight = _tableLineHeight;
  copy->_tableHeaderFontFamily = [_tableHeaderFontFamily copy];
  copy->_tableHeaderBackgroundColor = [_tableHeaderBackgroundColor copy];
  copy->_tableHeaderTextColor = [_tableHeaderTextColor copy];
  copy->_tableRowEvenBackgroundColor = [_tableRowEvenBackgroundColor copy];
  copy->_tableRowOddBackgroundColor = [_tableRowOddBackgroundColor copy];
  copy->_tableBorderColor = [_tableBorderColor copy];
  copy->_tableBorderWidth = _tableBorderWidth;
  copy->_tableBorderRadius = _tableBorderRadius;
  copy->_tableCellPaddingHorizontal = _tableCellPaddingHorizontal;
  copy->_tableCellPaddingVertical = _tableCellPaddingVertical;
  copy->_tableHorizontalOverflow = _tableHorizontalOverflow;
  copy->_tableAlign = [_tableAlign copy];
  copy->_taskListCheckedColor = [_taskListCheckedColor copy];
  copy->_taskListBorderColor = [_taskListBorderColor copy];
  copy->_taskListCheckboxSize = _taskListCheckboxSize;
  copy->_taskListCheckboxBorderRadius = _taskListCheckboxBorderRadius;
  copy->_taskListCheckmarkColor = [_taskListCheckmarkColor copy];
  copy->_taskListCheckedTextColor = [_taskListCheckedTextColor copy];
  copy->_taskListCheckedStrikethrough = _taskListCheckedStrikethrough;
  copy->_mathFontSize = _mathFontSize;
  copy->_mathColor = [_mathColor copy];
  copy->_mathBackgroundColor = [_mathBackgroundColor copy];
  copy->_mathPadding = _mathPadding;
  copy->_mathMarginTop = _mathMarginTop;
  copy->_mathMarginBottom = _mathMarginBottom;
  copy->_mathTextAlign = [_mathTextAlign copy];
  copy->_inlineMathColor = [_inlineMathColor copy];
  copy->_spoilerColor = [_spoilerColor copy];
  copy->_spoilerParticleDensity = _spoilerParticleDensity;
  copy->_spoilerParticleSpeed = _spoilerParticleSpeed;
  copy->_spoilerSolidBorderRadius = _spoilerSolidBorderRadius;
  copy->_superscriptFontScale = _superscriptFontScale;
  copy->_superscriptBaselineOffsetScale = _superscriptBaselineOffsetScale;
  copy->_subscriptFontScale = _subscriptFontScale;
  copy->_subscriptBaselineOffsetScale = _subscriptBaselineOffsetScale;

  return copy;
}

- (RCTUIColor *)primaryColor
{
  return _primaryColor != nullptr ? _primaryColor : [RCTUIColor blackColor];
}

- (void)setPrimaryColor:(RCTUIColor *)newValue
{
  _primaryColor = newValue;
}

- (NSNumber *)primaryFontSize
{
  return _primaryFontSize != nullptr ? _primaryFontSize : @16;
}

- (void)setPrimaryFontSize:(NSNumber *)newValue
{
  _primaryFontSize = newValue;
  [_primaryFont invalidate];
}

- (NSString *)primaryFontWeight
{
  return _primaryFontWeight != nullptr ? _primaryFontWeight : @"normal";
}

- (void)setPrimaryFontWeight:(NSString *)newValue
{
  _primaryFontWeight = newValue;
  [_primaryFont invalidate];
}

- (NSString *)primaryFontFamily
{
  return _primaryFontFamily;
}

- (void)setPrimaryFontFamily:(NSString *)newValue
{
  _primaryFontFamily = newValue;
  [_primaryFont invalidate];
}

- (UIFont *)primaryFont
{
  if (_primaryFont.needsRecreation || !_primaryFont.cachedFont) {
    _primaryFont.cachedFont =
        [RCTFont updateFont:nil
                 withFamily:_primaryFontFamily
                       size:_primaryFontSize
                     weight:normalizedFontWeight(_primaryFontWeight)
                      style:nil
                    variant:nil
            scaleMultiplier:[self effectiveScaleMultiplierForFontSize:[_primaryFontSize floatValue]]];
    _primaryFont.needsRecreation = NO;
  }
  return _primaryFont.cachedFont;
}

// Paragraph properties
- (CGFloat)paragraphFontSize
{
  return _paragraphFontSize;
}

- (void)setParagraphFontSize:(CGFloat)newValue
{
  _paragraphFontSize = newValue;
  [_paragraphFont invalidate];
}

- (NSString *)paragraphFontFamily
{
  return _paragraphFontFamily;
}

- (void)setParagraphFontFamily:(NSString *)newValue
{
  _paragraphFontFamily = newValue;
  [_paragraphFont invalidate];
}

- (NSString *)paragraphFontWeight
{
  return _paragraphFontWeight;
}

- (void)setParagraphFontWeight:(NSString *)newValue
{
  _paragraphFontWeight = newValue;
  [_paragraphFont invalidate];
}

- (RCTUIColor *)paragraphColor
{
  return _paragraphColor;
}

- (void)setParagraphColor:(RCTUIColor *)newValue
{
  _paragraphColor = newValue;
}

- (CGFloat)paragraphMarginTop
{
  return _paragraphMarginTop;
}

- (void)setParagraphMarginTop:(CGFloat)newValue
{
  _paragraphMarginTop = newValue;
}

- (CGFloat)paragraphMarginBottom
{
  return _paragraphMarginBottom;
}

- (void)setParagraphMarginBottom:(CGFloat)newValue
{
  _paragraphMarginBottom = newValue;
}

- (CGFloat)paragraphLineHeight
{
  if (_allowFontScaling && _paragraphLineHeight > 0) {
    return _paragraphLineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _paragraphLineHeight;
}

- (void)setParagraphLineHeight:(CGFloat)newValue
{
  _paragraphLineHeight = newValue;
}

- (NSTextAlignment)paragraphTextAlign
{
  return _paragraphTextAlign;
}

- (void)setParagraphTextAlign:(NSTextAlignment)newValue
{
  _paragraphTextAlign = newValue;
}

- (UIFont *)paragraphFont
{
  if (_paragraphFont.needsRecreation || !_paragraphFont.cachedFont) {
    _paragraphFont.cachedFont = [RCTFont updateFont:nil
                                         withFamily:_paragraphFontFamily
                                               size:@(_paragraphFontSize)
                                             weight:normalizedFontWeight(_paragraphFontWeight)
                                              style:nil
                                            variant:nil
                                    scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_paragraphFontSize]];
    _paragraphFont.needsRecreation = NO;
  }
  return _paragraphFont.cachedFont;
}

- (CGFloat)h1FontSize
{
  return _h1FontSize;
}

- (void)setH1FontSize:(CGFloat)newValue
{
  _h1FontSize = newValue;
  [_h1Font invalidate];
}

- (NSString *)h1FontFamily
{
  return _h1FontFamily;
}

- (void)setH1FontFamily:(NSString *)newValue
{
  _h1FontFamily = newValue;
  [_h1Font invalidate];
}

- (NSString *)h1FontWeight
{
  return _h1FontWeight;
}

- (void)setH1FontWeight:(NSString *)newValue
{
  _h1FontWeight = newValue;
  [_h1Font invalidate];
}

- (RCTUIColor *)h1Color
{
  return _h1Color;
}

- (void)setH1Color:(RCTUIColor *)newValue
{
  _h1Color = newValue;
}

- (CGFloat)h1MarginTop
{
  return _h1MarginTop;
}

- (void)setH1MarginTop:(CGFloat)newValue
{
  _h1MarginTop = newValue;
}

- (CGFloat)h1MarginBottom
{
  return _h1MarginBottom;
}

- (void)setH1MarginBottom:(CGFloat)newValue
{
  _h1MarginBottom = newValue;
}

- (CGFloat)h1LineHeight
{
  if (_allowFontScaling && _h1LineHeight > 0) {
    return _h1LineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _h1LineHeight;
}

- (void)setH1LineHeight:(CGFloat)newValue
{
  _h1LineHeight = newValue;
}

- (NSTextAlignment)h1TextAlign
{
  return _h1TextAlign;
}

- (void)setH1TextAlign:(NSTextAlignment)newValue
{
  _h1TextAlign = newValue;
}

- (UIFont *)h1Font
{
  if (_h1Font.needsRecreation || !_h1Font.cachedFont) {
    _h1Font.cachedFont = [RCTFont updateFont:nil
                                  withFamily:_h1FontFamily
                                        size:@(_h1FontSize)
                                      weight:normalizedFontWeight(_h1FontWeight)
                                       style:nil
                                     variant:nil
                             scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_h1FontSize]];
    _h1Font.needsRecreation = NO;
  }
  return _h1Font.cachedFont;
}

- (CGFloat)h2FontSize
{
  return _h2FontSize;
}

- (void)setH2FontSize:(CGFloat)newValue
{
  _h2FontSize = newValue;
  [_h2Font invalidate];
}

- (NSString *)h2FontFamily
{
  return _h2FontFamily;
}

- (void)setH2FontFamily:(NSString *)newValue
{
  _h2FontFamily = newValue;
  [_h2Font invalidate];
}

- (NSString *)h2FontWeight
{
  return _h2FontWeight;
}

- (void)setH2FontWeight:(NSString *)newValue
{
  _h2FontWeight = newValue;
  [_h2Font invalidate];
}

- (RCTUIColor *)h2Color
{
  return _h2Color;
}

- (void)setH2Color:(RCTUIColor *)newValue
{
  _h2Color = newValue;
}

- (CGFloat)h2MarginTop
{
  return _h2MarginTop;
}

- (void)setH2MarginTop:(CGFloat)newValue
{
  _h2MarginTop = newValue;
}

- (CGFloat)h2MarginBottom
{
  return _h2MarginBottom;
}

- (void)setH2MarginBottom:(CGFloat)newValue
{
  _h2MarginBottom = newValue;
}

- (CGFloat)h2LineHeight
{
  if (_allowFontScaling && _h2LineHeight > 0) {
    return _h2LineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _h2LineHeight;
}

- (void)setH2LineHeight:(CGFloat)newValue
{
  _h2LineHeight = newValue;
}

- (NSTextAlignment)h2TextAlign
{
  return _h2TextAlign;
}

- (void)setH2TextAlign:(NSTextAlignment)newValue
{
  _h2TextAlign = newValue;
}

- (UIFont *)h2Font
{
  if (_h2Font.needsRecreation || !_h2Font.cachedFont) {
    _h2Font.cachedFont = [RCTFont updateFont:nil
                                  withFamily:_h2FontFamily
                                        size:@(_h2FontSize)
                                      weight:normalizedFontWeight(_h2FontWeight)
                                       style:nil
                                     variant:nil
                             scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_h2FontSize]];
    _h2Font.needsRecreation = NO;
  }
  return _h2Font.cachedFont;
}

- (CGFloat)h3FontSize
{
  return _h3FontSize;
}

- (void)setH3FontSize:(CGFloat)newValue
{
  _h3FontSize = newValue;
  [_h3Font invalidate];
}

- (NSString *)h3FontFamily
{
  return _h3FontFamily;
}

- (void)setH3FontFamily:(NSString *)newValue
{
  _h3FontFamily = newValue;
  [_h3Font invalidate];
}

- (NSString *)h3FontWeight
{
  return _h3FontWeight;
}

- (void)setH3FontWeight:(NSString *)newValue
{
  _h3FontWeight = newValue;
  [_h3Font invalidate];
}

- (RCTUIColor *)h3Color
{
  return _h3Color;
}

- (void)setH3Color:(RCTUIColor *)newValue
{
  _h3Color = newValue;
}

- (CGFloat)h3MarginTop
{
  return _h3MarginTop;
}

- (void)setH3MarginTop:(CGFloat)newValue
{
  _h3MarginTop = newValue;
}

- (CGFloat)h3MarginBottom
{
  return _h3MarginBottom;
}

- (void)setH3MarginBottom:(CGFloat)newValue
{
  _h3MarginBottom = newValue;
}

- (CGFloat)h3LineHeight
{
  if (_allowFontScaling && _h3LineHeight > 0) {
    return _h3LineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _h3LineHeight;
}

- (void)setH3LineHeight:(CGFloat)newValue
{
  _h3LineHeight = newValue;
}

- (NSTextAlignment)h3TextAlign
{
  return _h3TextAlign;
}

- (void)setH3TextAlign:(NSTextAlignment)newValue
{
  _h3TextAlign = newValue;
}

- (UIFont *)h3Font
{
  if (_h3Font.needsRecreation || !_h3Font.cachedFont) {
    _h3Font.cachedFont = [RCTFont updateFont:nil
                                  withFamily:_h3FontFamily
                                        size:@(_h3FontSize)
                                      weight:normalizedFontWeight(_h3FontWeight)
                                       style:nil
                                     variant:nil
                             scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_h3FontSize]];
    _h3Font.needsRecreation = NO;
  }
  return _h3Font.cachedFont;
}

- (CGFloat)h4FontSize
{
  return _h4FontSize;
}

- (void)setH4FontSize:(CGFloat)newValue
{
  _h4FontSize = newValue;
  [_h4Font invalidate];
}

- (NSString *)h4FontFamily
{
  return _h4FontFamily;
}

- (void)setH4FontFamily:(NSString *)newValue
{
  _h4FontFamily = newValue;
  [_h4Font invalidate];
}

- (NSString *)h4FontWeight
{
  return _h4FontWeight;
}

- (void)setH4FontWeight:(NSString *)newValue
{
  _h4FontWeight = newValue;
  [_h4Font invalidate];
}

- (RCTUIColor *)h4Color
{
  return _h4Color;
}

- (void)setH4Color:(RCTUIColor *)newValue
{
  _h4Color = newValue;
}

- (CGFloat)h4MarginTop
{
  return _h4MarginTop;
}

- (void)setH4MarginTop:(CGFloat)newValue
{
  _h4MarginTop = newValue;
}

- (CGFloat)h4MarginBottom
{
  return _h4MarginBottom;
}

- (void)setH4MarginBottom:(CGFloat)newValue
{
  _h4MarginBottom = newValue;
}

- (CGFloat)h4LineHeight
{
  if (_allowFontScaling && _h4LineHeight > 0) {
    return _h4LineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _h4LineHeight;
}

- (void)setH4LineHeight:(CGFloat)newValue
{
  _h4LineHeight = newValue;
}

- (NSTextAlignment)h4TextAlign
{
  return _h4TextAlign;
}

- (void)setH4TextAlign:(NSTextAlignment)newValue
{
  _h4TextAlign = newValue;
}

- (UIFont *)h4Font
{
  if (_h4Font.needsRecreation || !_h4Font.cachedFont) {
    _h4Font.cachedFont = [RCTFont updateFont:nil
                                  withFamily:_h4FontFamily
                                        size:@(_h4FontSize)
                                      weight:normalizedFontWeight(_h4FontWeight)
                                       style:nil
                                     variant:nil
                             scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_h4FontSize]];
    _h4Font.needsRecreation = NO;
  }
  return _h4Font.cachedFont;
}

- (CGFloat)h5FontSize
{
  return _h5FontSize;
}

- (void)setH5FontSize:(CGFloat)newValue
{
  _h5FontSize = newValue;
  [_h5Font invalidate];
}

- (NSString *)h5FontFamily
{
  return _h5FontFamily;
}

- (void)setH5FontFamily:(NSString *)newValue
{
  _h5FontFamily = newValue;
  [_h5Font invalidate];
}

- (NSString *)h5FontWeight
{
  return _h5FontWeight;
}

- (void)setH5FontWeight:(NSString *)newValue
{
  _h5FontWeight = newValue;
  [_h5Font invalidate];
}

- (RCTUIColor *)h5Color
{
  return _h5Color;
}

- (void)setH5Color:(RCTUIColor *)newValue
{
  _h5Color = newValue;
}

- (CGFloat)h5MarginTop
{
  return _h5MarginTop;
}

- (void)setH5MarginTop:(CGFloat)newValue
{
  _h5MarginTop = newValue;
}

- (CGFloat)h5MarginBottom
{
  return _h5MarginBottom;
}

- (void)setH5MarginBottom:(CGFloat)newValue
{
  _h5MarginBottom = newValue;
}

- (CGFloat)h5LineHeight
{
  if (_allowFontScaling && _h5LineHeight > 0) {
    return _h5LineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _h5LineHeight;
}

- (void)setH5LineHeight:(CGFloat)newValue
{
  _h5LineHeight = newValue;
}

- (NSTextAlignment)h5TextAlign
{
  return _h5TextAlign;
}

- (void)setH5TextAlign:(NSTextAlignment)newValue
{
  _h5TextAlign = newValue;
}

- (UIFont *)h5Font
{
  if (_h5Font.needsRecreation || !_h5Font.cachedFont) {
    _h5Font.cachedFont = [RCTFont updateFont:nil
                                  withFamily:_h5FontFamily
                                        size:@(_h5FontSize)
                                      weight:normalizedFontWeight(_h5FontWeight)
                                       style:nil
                                     variant:nil
                             scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_h5FontSize]];
    _h5Font.needsRecreation = NO;
  }
  return _h5Font.cachedFont;
}

- (CGFloat)h6FontSize
{
  return _h6FontSize;
}

- (void)setH6FontSize:(CGFloat)newValue
{
  _h6FontSize = newValue;
  [_h6Font invalidate];
}

- (NSString *)h6FontFamily
{
  return _h6FontFamily;
}

- (void)setH6FontFamily:(NSString *)newValue
{
  _h6FontFamily = newValue;
  [_h6Font invalidate];
}

- (NSString *)h6FontWeight
{
  return _h6FontWeight;
}

- (void)setH6FontWeight:(NSString *)newValue
{
  _h6FontWeight = newValue;
  [_h6Font invalidate];
}

- (RCTUIColor *)h6Color
{
  return _h6Color;
}

- (void)setH6Color:(RCTUIColor *)newValue
{
  _h6Color = newValue;
}

- (CGFloat)h6MarginTop
{
  return _h6MarginTop;
}

- (void)setH6MarginTop:(CGFloat)newValue
{
  _h6MarginTop = newValue;
}

- (CGFloat)h6MarginBottom
{
  return _h6MarginBottom;
}

- (void)setH6MarginBottom:(CGFloat)newValue
{
  _h6MarginBottom = newValue;
}

- (CGFloat)h6LineHeight
{
  if (_allowFontScaling && _h6LineHeight > 0) {
    return _h6LineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _h6LineHeight;
}

- (void)setH6LineHeight:(CGFloat)newValue
{
  _h6LineHeight = newValue;
}

- (NSTextAlignment)h6TextAlign
{
  return _h6TextAlign;
}

- (void)setH6TextAlign:(NSTextAlignment)newValue
{
  _h6TextAlign = newValue;
}

- (UIFont *)h6Font
{
  if (_h6Font.needsRecreation || !_h6Font.cachedFont) {
    _h6Font.cachedFont = [RCTFont updateFont:nil
                                  withFamily:_h6FontFamily
                                        size:@(_h6FontSize)
                                      weight:normalizedFontWeight(_h6FontWeight)
                                       style:nil
                                     variant:nil
                             scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_h6FontSize]];
    _h6Font.needsRecreation = NO;
  }
  return _h6Font.cachedFont;
}

- (NSString *)linkFontFamily
{
  return _linkFontFamily;
}

- (void)setLinkFontFamily:(NSString *)newValue
{
  _linkFontFamily = newValue;
}

- (RCTUIColor *)linkColor
{
  return _linkColor;
}

- (void)setLinkColor:(RCTUIColor *)newValue
{
  _linkColor = newValue;
}

- (BOOL)linkUnderline
{
  return _linkUnderline;
}

- (void)setLinkUnderline:(BOOL)newValue
{
  _linkUnderline = newValue;
}

- (RCTUIColor *)linkBackgroundColor
{
  return _linkBackgroundColor;
}

- (void)setLinkBackgroundColor:(RCTUIColor *)newValue
{
  _linkBackgroundColor = newValue;
}

- (NSArray<LinkVariantConfig *> *)linkVariants
{
  return _linkVariants;
}

/// The JS normalizer validates patterns before they reach native, but iOS and JS
/// regex dialects still differ. Keep each compiled regex paired with its source
/// variant so an unsupported pattern cannot shift later matches.
- (void)setLinkVariants:(NSArray<LinkVariantConfig *> *)newValue
{
  _linkVariants = newValue;
  NSMutableArray<LinkVariantRegexEntry *> *compiledEntries = [NSMutableArray arrayWithCapacity:newValue.count];
  for (LinkVariantConfig *variant in newValue) {
    NSError *error = nil;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:variant.pattern
                                                                           options:0
                                                                             error:&error];
    if (regex) {
      LinkVariantRegexEntry *entry = [[LinkVariantRegexEntry alloc] init];
      entry.regex = regex;
      entry.variant = variant;
      [compiledEntries addObject:entry];
    }
  }
  _compiledVariantRegexes = [compiledEntries copy];
}

- (nullable LinkVariantConfig *)effectiveLinkVariantForURL:(NSString *)url
{
  if (_linkVariants.count == 0)
    return nil;
  NSUInteger len = url.length;
  for (NSUInteger i = 0; i < _compiledVariantRegexes.count; i++) {
    LinkVariantRegexEntry *entry = _compiledVariantRegexes[i];
    if ([entry.regex rangeOfFirstMatchInString:url options:0 range:NSMakeRange(0, len)].location != NSNotFound) {
      return entry.variant;
    }
  }
  return nil;
}

- (NSString *)strongFontFamily
{
  return _strongFontFamily;
}

- (void)setStrongFontFamily:(NSString *)newValue
{
  _strongFontFamily = newValue;
}

- (NSString *)strongFontWeight
{
  return _strongFontWeight;
}

- (void)setStrongFontWeight:(NSString *)newValue
{
  _strongFontWeight = newValue;
}

- (RCTUIColor *)strongColor
{
  return _strongColor;
}

- (void)setStrongColor:(RCTUIColor *)newValue
{
  _strongColor = newValue;
}

- (NSString *)emphasisFontFamily
{
  return _emphasisFontFamily;
}

- (void)setEmphasisFontFamily:(NSString *)newValue
{
  _emphasisFontFamily = newValue;
}

- (NSString *)emphasisFontStyle
{
  return _emphasisFontStyle;
}

- (void)setEmphasisFontStyle:(NSString *)newValue
{
  _emphasisFontStyle = newValue;
}

- (RCTUIColor *)emphasisColor
{
  return _emphasisColor;
}

- (void)setEmphasisColor:(RCTUIColor *)newValue
{
  _emphasisColor = newValue;
}

- (RCTUIColor *)strikethroughColor
{
  return _strikethroughColor;
}

- (void)setStrikethroughColor:(RCTUIColor *)newValue
{
  _strikethroughColor = newValue;
}

- (RCTUIColor *)highlightColor
{
  return _highlightColor;
}

- (void)setHighlightColor:(RCTUIColor *)newValue
{
  _highlightColor = newValue;
}

- (RCTUIColor *)highlightBackgroundColor
{
  return _highlightBackgroundColor;
}

- (void)setHighlightBackgroundColor:(RCTUIColor *)newValue
{
  _highlightBackgroundColor = newValue;
}

- (RCTUIColor *)underlineColor
{
  return _underlineColor;
}

- (void)setUnderlineColor:(RCTUIColor *)newValue
{
  _underlineColor = newValue;
}

- (NSString *)codeFontFamily
{
  return _codeFontFamily;
}

- (void)setCodeFontFamily:(NSString *)newValue
{
  _codeFontFamily = newValue;
}

- (CGFloat)codeFontScale
{
  return _codeFontScale;
}

- (void)setCodeFontScale:(CGFloat)newValue
{
  _codeFontScale = newValue;
}

- (CGFloat)codeFontSize
{
  return _codeFontSize;
}

- (void)setCodeFontSize:(CGFloat)newValue
{
  _codeFontSize = newValue;
}

- (RCTUIColor *)codeColor
{
  return _codeColor;
}

- (void)setCodeColor:(RCTUIColor *)newValue
{
  _codeColor = newValue;
}

- (RCTUIColor *)codeBackgroundColor
{
  return _codeBackgroundColor;
}

- (void)setCodeBackgroundColor:(RCTUIColor *)newValue
{
  _codeBackgroundColor = newValue;
}

- (RCTUIColor *)codeBorderColor
{
  return _codeBorderColor;
}

- (void)setCodeBorderColor:(RCTUIColor *)newValue
{
  _codeBorderColor = newValue;
}

- (CGFloat)imageHeight
{
  return _imageHeight;
}

- (void)setImageHeight:(CGFloat)newValue
{
  _imageHeight = newValue;
}

- (CGFloat)imageMaxHeight
{
  return _imageMaxHeight;
}

- (void)setImageMaxHeight:(CGFloat)newValue
{
  _imageMaxHeight = newValue;
}

- (CGFloat)imageAspectRatio
{
  return _imageAspectRatio;
}

- (void)setImageAspectRatio:(CGFloat)newValue
{
  _imageAspectRatio = newValue;
}

- (NSString *)imageResizeMode
{
  return _imageResizeMode ?: @"";
}

- (void)setImageResizeMode:(NSString *)newValue
{
  _imageResizeMode = newValue;
}

- (CGFloat)imageBorderRadius
{
  return _imageBorderRadius;
}

- (void)setImageBorderRadius:(CGFloat)newValue
{
  _imageBorderRadius = newValue;
}

- (CGFloat)imageMarginTop
{
  return _imageMarginTop;
}

- (void)setImageMarginTop:(CGFloat)newValue
{
  _imageMarginTop = newValue;
}

- (CGFloat)imageMarginBottom
{
  return _imageMarginBottom;
}

- (void)setImageMarginBottom:(CGFloat)newValue
{
  _imageMarginBottom = newValue;
}

- (NSDictionary<NSString *, NSString *> *)imageRequestHeaders
{
  return _imageRequestHeaders;
}

- (void)setImageRequestHeaders:(NSDictionary<NSString *, NSString *> *)newValue
{
  _imageRequestHeaders = [newValue copy];
}

- (NSDictionary<NSString *, LinkPillContent *> *)linkPillContent
{
  return _linkPillContent;
}

- (void)setLinkPillContent:(NSDictionary<NSString *, LinkPillContent *> *)newValue
{
  _linkPillContent = [newValue copy];
}

- (CGFloat)videoMarginTop
{
  return _videoMarginTop;
}

- (void)setVideoMarginTop:(CGFloat)newValue
{
  _videoMarginTop = newValue;
}

- (CGFloat)videoMarginBottom
{
  return _videoMarginBottom;
}

- (void)setVideoMarginBottom:(CGFloat)newValue
{
  _videoMarginBottom = newValue;
}

- (CGFloat)videoBorderRadius
{
  return _videoBorderRadius;
}

- (void)setVideoBorderRadius:(CGFloat)newValue
{
  _videoBorderRadius = newValue;
}

- (CGFloat)videoAspectRatio
{
  return _videoAspectRatio;
}

- (void)setVideoAspectRatio:(CGFloat)newValue
{
  _videoAspectRatio = newValue;
}

- (RCTUIColor *)videoBackgroundColor
{
  return _videoBackgroundColor;
}

- (void)setVideoBackgroundColor:(RCTUIColor *)newValue
{
  _videoBackgroundColor = newValue;
}

- (CGFloat)inlineImageSize
{
  return _inlineImageSize;
}

- (void)setInlineImageSize:(CGFloat)newValue
{
  _inlineImageSize = newValue;
}

// Blockquote properties
- (CGFloat)blockquoteFontSize
{
  return _blockquoteFontSize;
}

- (void)setBlockquoteFontSize:(CGFloat)newValue
{
  _blockquoteFontSize = newValue;
  [_blockquoteFont invalidate];
}

- (NSString *)blockquoteFontFamily
{
  return _blockquoteFontFamily;
}

- (void)setBlockquoteFontFamily:(NSString *)newValue
{
  _blockquoteFontFamily = newValue;
  [_blockquoteFont invalidate];
}

- (NSString *)blockquoteFontWeight
{
  return _blockquoteFontWeight;
}

- (void)setBlockquoteFontWeight:(NSString *)newValue
{
  _blockquoteFontWeight = newValue;
  [_blockquoteFont invalidate];
}

- (RCTUIColor *)blockquoteColor
{
  return _blockquoteColor;
}

- (void)setBlockquoteColor:(RCTUIColor *)newValue
{
  _blockquoteColor = newValue;
}

- (CGFloat)blockquoteMarginTop
{
  return _blockquoteMarginTop;
}

- (void)setBlockquoteMarginTop:(CGFloat)newValue
{
  _blockquoteMarginTop = newValue;
}

- (CGFloat)blockquoteMarginBottom
{
  return _blockquoteMarginBottom;
}

- (void)setBlockquoteMarginBottom:(CGFloat)newValue
{
  _blockquoteMarginBottom = newValue;
}

- (CGFloat)blockquoteLineHeight
{
  if (_allowFontScaling && _blockquoteLineHeight > 0) {
    return _blockquoteLineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _blockquoteLineHeight;
}

- (void)setBlockquoteLineHeight:(CGFloat)newValue
{
  _blockquoteLineHeight = newValue;
}

- (UIFont *)blockquoteFont
{
  if (_blockquoteFont.needsRecreation || !_blockquoteFont.cachedFont) {
    _blockquoteFont.cachedFont = [RCTFont updateFont:nil
                                          withFamily:_blockquoteFontFamily
                                                size:@(_blockquoteFontSize)
                                              weight:normalizedFontWeight(_blockquoteFontWeight)
                                               style:nil
                                             variant:nil
                                     scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_blockquoteFontSize]];
    _blockquoteFont.needsRecreation = NO;
  }
  return _blockquoteFont.cachedFont;
}

- (RCTUIColor *)blockquoteBorderColor
{
  return _blockquoteBorderColor;
}

- (void)setBlockquoteBorderColor:(RCTUIColor *)newValue
{
  _blockquoteBorderColor = newValue;
}

- (CGFloat)blockquoteBorderWidth
{
  return _blockquoteBorderWidth;
}

- (void)setBlockquoteBorderWidth:(CGFloat)newValue
{
  _blockquoteBorderWidth = newValue;
}

- (CGFloat)blockquoteGapWidth
{
  return _blockquoteGapWidth;
}

- (void)setBlockquoteGapWidth:(CGFloat)newValue
{
  _blockquoteGapWidth = newValue;
}

- (RCTUIColor *)blockquoteBackgroundColor
{
  return _blockquoteBackgroundColor;
}

- (void)setBlockquoteBackgroundColor:(RCTUIColor *)newValue
{
  _blockquoteBackgroundColor = newValue;
}

- (CGFloat)blockquoteBorderRadius
{
  return _blockquoteBorderRadius;
}

- (void)setBlockquoteBorderRadius:(CGFloat)newValue
{
  _blockquoteBorderRadius = newValue;
}

- (CGFloat)blockquotePadding
{
  return _blockquotePadding;
}

- (void)setBlockquotePadding:(CGFloat)newValue
{
  _blockquotePadding = newValue;
}

- (void)setAdmonitionColors:(NSDictionary<NSString *, RCTUIColor *> *)colors
           backgroundColors:(NSDictionary<NSString *, RCTUIColor *> *)backgroundColors
{
  _admonitionColors = [colors copy];
  _admonitionBackgroundColors = [backgroundColors copy];
}

// The tint (border + title + icon) for an admonition type; falls back to the
// base blockquote border color if the type was never configured.
- (RCTUIColor *)admonitionColorForType:(NSString *)type
{
  RCTUIColor *color = _admonitionColors[type];
  return color ?: _blockquoteBorderColor;
}

// The callout fill for an admonition type; clear (no fill) when unset.
- (RCTUIColor *)admonitionBackgroundColorForType:(NSString *)type
{
  RCTUIColor *color = _admonitionBackgroundColors[type];
  return color ?: [RCTUIColor clearColor];
}

// List style properties (combined for both ordered and unordered lists)
- (CGFloat)listStyleFontSize
{
  return _listStyleFontSize;
}

- (void)setListStyleFontSize:(CGFloat)newValue
{
  _listStyleFontSize = newValue;
  [_listMarkerFont invalidate];
  [_listStyleFont invalidate];
}

- (NSString *)listStyleFontFamily
{
  return _listStyleFontFamily;
}

- (void)setListStyleFontFamily:(NSString *)newValue
{
  _listStyleFontFamily = newValue;
  [_listMarkerFont invalidate];
  [_listStyleFont invalidate];
}

- (NSString *)listStyleFontWeight
{
  return _listStyleFontWeight;
}

- (void)setListStyleFontWeight:(NSString *)newValue
{
  _listStyleFontWeight = newValue;
  [_listStyleFont invalidate];
}

- (RCTUIColor *)listStyleColor
{
  return _listStyleColor;
}

- (void)setListStyleColor:(RCTUIColor *)newValue
{
  _listStyleColor = newValue;
}

- (CGFloat)listStyleMarginTop
{
  return _listStyleMarginTop;
}

- (void)setListStyleMarginTop:(CGFloat)newValue
{
  _listStyleMarginTop = newValue;
}

- (CGFloat)listStyleMarginBottom
{
  return _listStyleMarginBottom;
}

- (void)setListStyleMarginBottom:(CGFloat)newValue
{
  _listStyleMarginBottom = newValue;
}

- (CGFloat)listStyleLineHeight
{
  if (_allowFontScaling && _listStyleLineHeight > 0) {
    return _listStyleLineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _listStyleLineHeight;
}

- (void)setListStyleLineHeight:(CGFloat)newValue
{
  _listStyleLineHeight = newValue;
}

- (RCTUIColor *)listStyleBulletColor
{
  return _listStyleBulletColor;
}

- (void)setListStyleBulletColor:(RCTUIColor *)newValue
{
  _listStyleBulletColor = newValue;
}

- (CGFloat)listStyleBulletSize
{
  return _listStyleBulletSize;
}

- (void)setListStyleBulletSize:(CGFloat)newValue
{
  _listStyleBulletSize = newValue;
}

- (CGFloat)listStyleMarkerMinWidth
{
  return _listStyleMarkerMinWidth;
}

- (void)setListStyleMarkerMinWidth:(CGFloat)newValue
{
  _listStyleMarkerMinWidth = newValue;
}

- (RCTUIColor *)listStyleMarkerColor
{
  return _listStyleMarkerColor;
}

- (void)setListStyleMarkerColor:(RCTUIColor *)newValue
{
  _listStyleMarkerColor = newValue;
}

- (NSString *)listStyleMarkerFontWeight
{
  return _listStyleMarkerFontWeight;
}

- (void)setListStyleMarkerFontWeight:(NSString *)newValue
{
  _listStyleMarkerFontWeight = newValue;
  [_listMarkerFont invalidate];
}

- (CGFloat)listStyleGapWidth
{
  return _listStyleGapWidth;
}

- (void)setListStyleGapWidth:(CGFloat)newValue
{
  _listStyleGapWidth = newValue;
}

- (CGFloat)listStyleMarginLeft
{
  return _listStyleMarginLeft;
}

- (void)setListStyleMarginLeft:(CGFloat)newValue
{
  _listStyleMarginLeft = newValue;
}

- (CGFloat)listStyleItemSpacing
{
  return _listStyleItemSpacing;
}

- (void)setListStyleItemSpacing:(CGFloat)newValue
{
  _listStyleItemSpacing = newValue;
}

- (UIFont *)listMarkerFont
{
  if (_listMarkerFont.needsRecreation || !_listMarkerFont.cachedFont) {
    _listMarkerFont.cachedFont = [RCTFont updateFont:nil
                                          withFamily:_listStyleFontFamily
                                                size:@(_listStyleFontSize)
                                              weight:normalizedFontWeight(_listStyleMarkerFontWeight)
                                               style:nil
                                             variant:nil
                                     scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_listStyleFontSize]];
    _listMarkerFont.needsRecreation = NO;
  }
  return _listMarkerFont.cachedFont;
}

- (UIFont *)listStyleFont
{
  if (_listStyleFont.needsRecreation || !_listStyleFont.cachedFont) {
    _listStyleFont.cachedFont = [RCTFont updateFont:nil
                                         withFamily:_listStyleFontFamily
                                               size:@(_listStyleFontSize)
                                             weight:normalizedFontWeight(_listStyleFontWeight)
                                              style:nil
                                            variant:nil
                                    scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_listStyleFontSize]];
    _listStyleFont.needsRecreation = NO;
  }
  return _listStyleFont.cachedFont;
}

static const CGFloat kDefaultMinGap = 4.0;

- (CGFloat)effectiveListGapWidth
{
  return MAX(_listStyleGapWidth, kDefaultMinGap);
}

- (CGFloat)effectiveListMarginLeftForBullet
{
  return MAX(_listStyleMarkerMinWidth, _listStyleBulletSize / 2.0);
}

- (CGFloat)effectiveListMarginLeftForNumber
{
  UIFont *font = [self listMarkerFont];
  CGFloat natural =
      [@"99." sizeWithAttributes:@{NSFontAttributeName : font ?: [UIFont systemFontOfSize:_listStyleFontSize]}].width;
  return MAX(_listStyleMarkerMinWidth, natural);
}

- (CGFloat)effectiveListMarginLeftForTask
{
  return MAX(_listStyleMarkerMinWidth, [self taskListCheckboxSize]);
}

// Code block properties
- (CGFloat)codeBlockFontSize
{
  return _codeBlockFontSize;
}

- (void)setCodeBlockFontSize:(CGFloat)newValue
{
  _codeBlockFontSize = newValue;
  [_codeBlockFont invalidate];
}

- (NSString *)codeBlockFontFamily
{
  return _codeBlockFontFamily;
}

- (void)setCodeBlockFontFamily:(NSString *)newValue
{
  _codeBlockFontFamily = newValue;
  [_codeBlockFont invalidate];
}

- (NSString *)codeBlockFontWeight
{
  return _codeBlockFontWeight;
}

- (void)setCodeBlockFontWeight:(NSString *)newValue
{
  _codeBlockFontWeight = newValue;
  [_codeBlockFont invalidate];
}

- (RCTUIColor *)codeBlockColor
{
  return _codeBlockColor;
}

- (void)setCodeBlockColor:(RCTUIColor *)newValue
{
  _codeBlockColor = newValue;
}

- (CGFloat)codeBlockMarginTop
{
  return _codeBlockMarginTop;
}

- (void)setCodeBlockMarginTop:(CGFloat)newValue
{
  _codeBlockMarginTop = newValue;
}

- (CGFloat)codeBlockMarginBottom
{
  return _codeBlockMarginBottom;
}

- (void)setCodeBlockMarginBottom:(CGFloat)newValue
{
  _codeBlockMarginBottom = newValue;
}

- (CGFloat)codeBlockLineHeight
{
  if (_allowFontScaling && _codeBlockLineHeight > 0) {
    return _codeBlockLineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _codeBlockLineHeight;
}

- (void)setCodeBlockLineHeight:(CGFloat)newValue
{
  _codeBlockLineHeight = newValue;
}

- (RCTUIColor *)codeBlockBackgroundColor
{
  return _codeBlockBackgroundColor;
}

- (void)setCodeBlockBackgroundColor:(RCTUIColor *)newValue
{
  _codeBlockBackgroundColor = newValue;
}

- (RCTUIColor *)codeBlockBorderColor
{
  return _codeBlockBorderColor;
}

- (void)setCodeBlockBorderColor:(RCTUIColor *)newValue
{
  _codeBlockBorderColor = newValue;
}

- (CGFloat)codeBlockBorderRadius
{
  return _codeBlockBorderRadius;
}

- (void)setCodeBlockBorderRadius:(CGFloat)newValue
{
  _codeBlockBorderRadius = newValue;
}

- (CGFloat)codeBlockBorderWidth
{
  return _codeBlockBorderWidth;
}

- (void)setCodeBlockBorderWidth:(CGFloat)newValue
{
  _codeBlockBorderWidth = newValue;
}

- (CGFloat)codeBlockPadding
{
  return _codeBlockPadding;
}

- (void)setCodeBlockPadding:(CGFloat)newValue
{
  _codeBlockPadding = newValue;
}

- (UIFont *)codeBlockFont
{
  if (_codeBlockFont.needsRecreation || !_codeBlockFont.cachedFont) {
    _codeBlockFont.cachedFont = [RCTFont updateFont:nil
                                         withFamily:_codeBlockFontFamily
                                               size:@(_codeBlockFontSize)
                                             weight:normalizedFontWeight(_codeBlockFontWeight)
                                              style:nil
                                            variant:nil
                                    scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_codeBlockFontSize]];
    _codeBlockFont.needsRecreation = NO;
  }
  return _codeBlockFont.cachedFont;
}

- (RCTUIColor *)codeBlockSyntaxColorForToken:(NSInteger)tokenType
{
  if (tokenType < 0 || tokenType >= kENRMCodeBlockSyntaxColorCount) {
    return nil;
  }
  return _codeBlockSyntaxColors[tokenType];
}

- (void)setCodeBlockSyntaxColor:(RCTUIColor *)newValue forToken:(NSInteger)tokenType
{
  if (tokenType < 0 || tokenType >= kENRMCodeBlockSyntaxColorCount) {
    return;
  }
  _codeBlockSyntaxColors[tokenType] = newValue;
}

// Thematic break properties
- (RCTUIColor *)thematicBreakColor
{
  return _thematicBreakColor;
}

- (void)setThematicBreakColor:(RCTUIColor *)newValue
{
  _thematicBreakColor = newValue;
}

- (CGFloat)thematicBreakHeight
{
  return _thematicBreakHeight;
}

- (void)setThematicBreakHeight:(CGFloat)newValue
{
  _thematicBreakHeight = newValue;
}

- (CGFloat)thematicBreakMarginTop
{
  return _thematicBreakMarginTop;
}

- (void)setThematicBreakMarginTop:(CGFloat)newValue
{
  _thematicBreakMarginTop = newValue;
}

- (CGFloat)thematicBreakMarginBottom
{
  return _thematicBreakMarginBottom;
}

- (void)setThematicBreakMarginBottom:(CGFloat)newValue
{
  _thematicBreakMarginBottom = newValue;
}

// Table properties
- (CGFloat)tableFontSize
{
  return _tableFontSize;
}

- (void)setTableFontSize:(CGFloat)newValue
{
  _tableFontSize = newValue;
  [_tableFont invalidate];
  [_tableHeaderFont invalidate];
}

- (NSString *)tableFontFamily
{
  return _tableFontFamily;
}

- (void)setTableFontFamily:(NSString *)newValue
{
  _tableFontFamily = newValue;
  [_tableFont invalidate];
  [_tableHeaderFont invalidate];
}

- (NSString *)tableFontWeight
{
  return _tableFontWeight;
}

- (void)setTableFontWeight:(NSString *)newValue
{
  _tableFontWeight = newValue;
  [_tableFont invalidate];
}

- (RCTUIColor *)tableColor
{
  return _tableColor;
}

- (void)setTableColor:(RCTUIColor *)newValue
{
  _tableColor = newValue;
}

- (CGFloat)tableMarginTop
{
  return _tableMarginTop;
}

- (void)setTableMarginTop:(CGFloat)newValue
{
  _tableMarginTop = newValue;
}

- (CGFloat)tableMarginBottom
{
  return _tableMarginBottom;
}

- (void)setTableMarginBottom:(CGFloat)newValue
{
  _tableMarginBottom = newValue;
}

- (CGFloat)tableLineHeight
{
  if (_allowFontScaling && _tableLineHeight > 0) {
    return _tableLineHeight * RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier);
  }
  return _tableLineHeight;
}

- (void)setTableLineHeight:(CGFloat)newValue
{
  _tableLineHeight = newValue;
}

- (UIFont *)tableFont
{
  if (_tableFont.needsRecreation || !_tableFont.cachedFont) {
    _tableFont.cachedFont = [RCTFont updateFont:nil
                                     withFamily:_tableFontFamily
                                           size:@(_tableFontSize)
                                         weight:normalizedFontWeight(_tableFontWeight)
                                          style:nil
                                        variant:nil
                                scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_tableFontSize]];
    _tableFont.needsRecreation = NO;
  }
  return _tableFont.cachedFont;
}

- (NSString *)tableHeaderFontFamily
{
  return _tableHeaderFontFamily;
}

- (void)setTableHeaderFontFamily:(NSString *)newValue
{
  _tableHeaderFontFamily = newValue;
  [_tableHeaderFont invalidate];
}

- (UIFont *)tableHeaderFont
{
  if (_tableHeaderFont.needsRecreation || !_tableHeaderFont.cachedFont) {
    NSString *family = (_tableHeaderFontFamily.length > 0) ? _tableHeaderFontFamily : _tableFontFamily;
    _tableHeaderFont.cachedFont = [RCTFont updateFont:nil
                                           withFamily:family
                                                 size:@(_tableFontSize)
                                               weight:normalizedFontWeight(@"bold")
                                                style:nil
                                              variant:nil
                                      scaleMultiplier:[self effectiveScaleMultiplierForFontSize:_tableFontSize]];
    _tableHeaderFont.needsRecreation = NO;
  }
  return _tableHeaderFont.cachedFont;
}

- (RCTUIColor *)tableHeaderBackgroundColor
{
  return _tableHeaderBackgroundColor;
}

- (void)setTableHeaderBackgroundColor:(RCTUIColor *)newValue
{
  _tableHeaderBackgroundColor = newValue;
}

- (RCTUIColor *)tableHeaderTextColor
{
  return _tableHeaderTextColor;
}

- (void)setTableHeaderTextColor:(RCTUIColor *)newValue
{
  _tableHeaderTextColor = newValue;
}

- (RCTUIColor *)tableRowEvenBackgroundColor
{
  return _tableRowEvenBackgroundColor;
}

- (void)setTableRowEvenBackgroundColor:(RCTUIColor *)newValue
{
  _tableRowEvenBackgroundColor = newValue;
}

- (RCTUIColor *)tableRowOddBackgroundColor
{
  return _tableRowOddBackgroundColor;
}

- (void)setTableRowOddBackgroundColor:(RCTUIColor *)newValue
{
  _tableRowOddBackgroundColor = newValue;
}

- (RCTUIColor *)tableBorderColor
{
  return _tableBorderColor;
}

- (void)setTableBorderColor:(RCTUIColor *)newValue
{
  _tableBorderColor = newValue;
}

- (CGFloat)tableBorderWidth
{
  return _tableBorderWidth;
}

- (void)setTableBorderWidth:(CGFloat)newValue
{
  _tableBorderWidth = newValue;
}

- (CGFloat)tableBorderRadius
{
  return _tableBorderRadius;
}

- (void)setTableBorderRadius:(CGFloat)newValue
{
  _tableBorderRadius = newValue;
}

- (CGFloat)tableCellPaddingHorizontal
{
  return _tableCellPaddingHorizontal;
}

- (void)setTableCellPaddingHorizontal:(CGFloat)newValue
{
  _tableCellPaddingHorizontal = newValue;
}

- (CGFloat)tableCellPaddingVertical
{
  return _tableCellPaddingVertical;
}

- (void)setTableCellPaddingVertical:(CGFloat)newValue
{
  _tableCellPaddingVertical = newValue;
}

- (CGFloat)tableHorizontalOverflow
{
  return _tableHorizontalOverflow;
}

- (void)setTableHorizontalOverflow:(CGFloat)newValue
{
  _tableHorizontalOverflow = newValue;
}

- (NSString *)tableAlign
{
  return _tableAlign ?: @"";
}

- (void)setTableAlign:(NSString *)newValue
{
  _tableAlign = newValue;
}

// Task list

- (RCTUIColor *)taskListCheckedColor
{
  return _taskListCheckedColor;
}

- (void)setTaskListCheckedColor:(RCTUIColor *)newValue
{
  _taskListCheckedColor = newValue;
}

- (RCTUIColor *)taskListBorderColor
{
  return _taskListBorderColor;
}

- (void)setTaskListBorderColor:(RCTUIColor *)newValue
{
  _taskListBorderColor = newValue;
}

- (CGFloat)taskListCheckboxSize
{
  return _taskListCheckboxSize;
}

- (void)setTaskListCheckboxSize:(CGFloat)newValue
{
  _taskListCheckboxSize = newValue;
}

- (CGFloat)taskListCheckboxBorderRadius
{
  return _taskListCheckboxBorderRadius;
}

- (void)setTaskListCheckboxBorderRadius:(CGFloat)newValue
{
  _taskListCheckboxBorderRadius = newValue;
}

- (RCTUIColor *)taskListCheckmarkColor
{
  return _taskListCheckmarkColor;
}

- (void)setTaskListCheckmarkColor:(RCTUIColor *)newValue
{
  _taskListCheckmarkColor = newValue;
}

- (RCTUIColor *)taskListCheckedTextColor
{
  return _taskListCheckedTextColor;
}

- (void)setTaskListCheckedTextColor:(RCTUIColor *)newValue
{
  _taskListCheckedTextColor = newValue;
}

- (BOOL)taskListCheckedStrikethrough
{
  return _taskListCheckedStrikethrough;
}

- (void)setTaskListCheckedStrikethrough:(BOOL)newValue
{
  _taskListCheckedStrikethrough = newValue;
}

// Math

- (CGFloat)mathFontSize
{
  return _mathFontSize;
}

- (void)setMathFontSize:(CGFloat)newValue
{
  _mathFontSize = newValue;
}

- (RCTUIColor *)mathColor
{
  return _mathColor;
}

- (void)setMathColor:(RCTUIColor *)newValue
{
  _mathColor = newValue;
}

- (RCTUIColor *)mathBackgroundColor
{
  return _mathBackgroundColor;
}

- (void)setMathBackgroundColor:(RCTUIColor *)newValue
{
  _mathBackgroundColor = newValue;
}

- (CGFloat)mathPadding
{
  return _mathPadding;
}

- (void)setMathPadding:(CGFloat)newValue
{
  _mathPadding = newValue;
}

- (CGFloat)mathMarginTop
{
  return _mathMarginTop;
}

- (void)setMathMarginTop:(CGFloat)newValue
{
  _mathMarginTop = newValue;
}

- (CGFloat)mathMarginBottom
{
  return _mathMarginBottom;
}

- (void)setMathMarginBottom:(CGFloat)newValue
{
  _mathMarginBottom = newValue;
}

- (NSString *)mathTextAlign
{
  return _mathTextAlign ?: @"center";
}

- (void)setMathTextAlign:(NSString *)newValue
{
  _mathTextAlign = newValue;
}

// ── Inline Math ─────────────────────────────────────────────────────────────

- (RCTUIColor *)inlineMathColor
{
  return _inlineMathColor;
}

- (void)setInlineMathColor:(RCTUIColor *)newValue
{
  _inlineMathColor = newValue;
}

// ── Spoiler ─────────────────────────────────────────────────────────────

- (RCTUIColor *)spoilerColor
{
  return _spoilerColor;
}

- (void)setSpoilerColor:(RCTUIColor *)newValue
{
  _spoilerColor = newValue;
}

- (CGFloat)spoilerParticleDensity
{
  return _spoilerParticleDensity;
}

- (void)setSpoilerParticleDensity:(CGFloat)newValue
{
  _spoilerParticleDensity = newValue;
}

- (CGFloat)spoilerParticleSpeed
{
  return _spoilerParticleSpeed;
}

- (void)setSpoilerParticleSpeed:(CGFloat)newValue
{
  _spoilerParticleSpeed = newValue;
}

- (CGFloat)spoilerSolidBorderRadius
{
  return _spoilerSolidBorderRadius;
}

- (void)setSpoilerSolidBorderRadius:(CGFloat)newValue
{
  _spoilerSolidBorderRadius = newValue;
}

- (CGFloat)superscriptFontScale
{
  return _superscriptFontScale;
}

- (void)setSuperscriptFontScale:(CGFloat)newValue
{
  _superscriptFontScale = newValue;
}

- (CGFloat)superscriptBaselineOffsetScale
{
  return _superscriptBaselineOffsetScale;
}

- (void)setSuperscriptBaselineOffsetScale:(CGFloat)newValue
{
  _superscriptBaselineOffsetScale = newValue;
}

- (CGFloat)subscriptFontScale
{
  return _subscriptFontScale;
}

- (void)setSubscriptFontScale:(CGFloat)newValue
{
  _subscriptFontScale = newValue;
}

- (CGFloat)subscriptBaselineOffsetScale
{
  return _subscriptBaselineOffsetScale;
}

- (void)setSubscriptBaselineOffsetScale:(CGFloat)newValue
{
  _subscriptBaselineOffsetScale = newValue;
}

@end
