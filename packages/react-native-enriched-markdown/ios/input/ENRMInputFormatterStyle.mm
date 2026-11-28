#import "ENRMInputFormatterStyle.h"
#import "FontUtils.h"

@implementation ENRMInputLinkVariantStyle
@end

@implementation ENRMInputFormatterStyle {
  NSMutableDictionary<NSNumber *, UIFont *> *_fontCache;
  UIFont *_lastBaseFont;
  CGFloat _headingFontSizes[7];
  NSString *_headingFontWeights[7];
  RCTUIColor *_headingColors[7];
  UIFont *_headingFontCache[7];
}

- (instancetype)init
{
  if (self = [super init]) {
    _baseFont = [UIFont systemFontOfSize:16.0];
    _baseTextColor = [RCTUIColor labelColor];
    _linkVariants = @[];
    _fontCache = [NSMutableDictionary dictionary];
    for (NSInteger level = 0; level <= 6; level++) {
      _headingFontSizes[level] = 0.0;
      _headingFontWeights[level] = nil;
      _headingColors[level] = nil;
    }
  }
  return self;
}

- (id)copyWithZone:(NSZone *)zone
{
  ENRMInputFormatterStyle *copy = [[ENRMInputFormatterStyle allocWithZone:zone] init];
  copy.baseFont = _baseFont;
  copy.baseTextColor = _baseTextColor;
  copy.baseLineHeight = _baseLineHeight;
  copy.boldColor = _boldColor;
  copy.italicColor = _italicColor;
  copy.linkColor = _linkColor;
  copy.linkUnderline = _linkUnderline;
  copy.linkBackgroundColor = _linkBackgroundColor;
  copy.linkVariants = [_linkVariants copy];
  copy.spoilerColor = _spoilerColor;
  copy.spoilerBackgroundColor = _spoilerBackgroundColor;
  copy.listItemSpacing = _listItemSpacing;
  for (NSInteger level = 1; level <= 6; level++) {
    [copy setHeadingFontSize:_headingFontSizes[level] forLevel:level];
    [copy setHeadingFontWeight:_headingFontWeights[level] forLevel:level];
    [copy setHeadingColor:_headingColors[level] forLevel:level];
  }
  return copy;
}

- (BOOL)isValidHeadingLevel:(NSInteger)level
{
  return level >= 1 && level <= 6;
}

- (void)setHeadingFontSize:(CGFloat)fontSize forLevel:(NSInteger)level
{
  if ([self isValidHeadingLevel:level]) {
    _headingFontSizes[level] = fontSize;
    _headingFontCache[level] = nil;
  }
}

- (void)setHeadingFontWeight:(nullable NSString *)fontWeight forLevel:(NSInteger)level
{
  if ([self isValidHeadingLevel:level]) {
    _headingFontWeights[level] = [fontWeight copy];
    _headingFontCache[level] = nil;
  }
}

- (void)setHeadingColor:(nullable RCTUIColor *)color forLevel:(NSInteger)level
{
  if ([self isValidHeadingLevel:level]) {
    _headingColors[level] = color;
  }
}

- (RCTUIColor *)headingColorForLevel:(NSInteger)level
{
  return [self isValidHeadingLevel:level] ? _headingColors[level] : nil;
}

- (UIFont *)headingFontForLevel:(NSInteger)level
{
  if (![self isValidHeadingLevel:level]) {
    return _baseFont;
  }

  [self invalidateCacheIfNeeded];

  UIFont *cached = _headingFontCache[level];
  if (cached) {
    return cached;
  }

  CGFloat size = _headingFontSizes[level];
  if (size <= 0.0) {
    size = _baseFont.pointSize;
  }

  NSString *weightString = _headingFontWeights[level];
  UIFont *font;
  if (weightString.length > 0) {
    UIFontWeight weight = ENRMFontWeightFromString(weightString);
    UIFontDescriptor *descriptor = [_baseFont.fontDescriptor
        fontDescriptorByAddingAttributes:@{UIFontDescriptorTraitsAttribute : @{UIFontWeightTrait : @(weight)}}];
    font = descriptor ? [UIFont fontWithDescriptor:descriptor size:size] : [UIFont systemFontOfSize:size weight:weight];
  } else {
    font = [_baseFont fontWithSize:size];
  }
  _headingFontCache[level] = font;
  return font;
}

- (CGFloat)derivedLineHeightForHeadingLevel:(NSInteger)level
{
  if (_baseLineHeight <= 0 || ![self isValidHeadingLevel:level]) {
    return 0;
  }

  // Use the font the heading is actually drawn with, so this can't drift from
  // headingFontForLevel's own size fallback.
  CGFloat headingFontSize = [self headingFontForLevel:level].pointSize;
  return headingFontSize + (_baseLineHeight - _baseFont.pointSize);
}

- (void)clearHeadingFontCache
{
  for (NSInteger level = 0; level <= 6; level++) {
    _headingFontCache[level] = nil;
  }
}

- (void)invalidateCacheIfNeeded
{
  if (_lastBaseFont != _baseFont) {
    [_fontCache removeAllObjects];
    [self clearHeadingFontCache];
    _lastBaseFont = _baseFont;
  }
}

- (void)invalidateFontCache
{
  [_fontCache removeAllObjects];
  [self clearHeadingFontCache];
  _lastBaseFont = nil;
}

- (UIFont *)fontForTraits:(UIFontDescriptorSymbolicTraits)traits
{
  [self invalidateCacheIfNeeded];

  if (traits == 0) {
    return _baseFont;
  }

  NSNumber *key = @(traits);
  UIFont *cached = _fontCache[key];
  if (cached) {
    return cached;
  }

  UIFontDescriptor *descriptor =
      [_baseFont.fontDescriptor fontDescriptorWithSymbolicTraits:_baseFont.fontDescriptor.symbolicTraits | traits];
  UIFont *derived = descriptor ? [UIFont fontWithDescriptor:descriptor size:0] : _baseFont;
  _fontCache[key] = derived;
  return derived;
}

@end
