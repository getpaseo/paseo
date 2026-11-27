#import "RenderContext.h"
#import "CodeBackground.h"
#import "FontUtils.h"
#import <React/RCTFont.h>

@implementation BlockStyle
@end

static NSArray<NSString *> *ENRMScopedKeyPaths(void)
{
  static NSArray<NSString *> *keyPaths;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    keyPaths = @[
      @"currentBlockType",
      @"currentHeadingLevel",
      @"currentBlockStyle.fontSize",
      @"currentBlockStyle.fontFamily",
      @"currentBlockStyle.fontWeight",
      @"currentBlockStyle.color",
      @"currentBlockStyle.cachedFont",
      @"currentBlockStyle.cachedTextAttributes",
      @"blockquoteDepth",
      @"listDepth",
      @"listType",
      @"listItemNumber",
      @"accumulatedIndent",
    ];
  });
  return keyPaths;
}

@implementation RenderContext {
  NSMutableDictionary<NSString *, UIFont *> *_fontCache;
  NSParagraphStyle *_baseSpacerTemplate;
  NSParagraphStyle *_baseBlockSpacerTemplate;
}

- (instancetype)init
{
  if (self = [super init]) {
    _linkRanges = [NSMutableArray array];
    _linkURLs = [NSMutableArray array];
    _headingRanges = [NSMutableArray array];
    _headingLevels = [NSMutableArray array];
    _imageRanges = [NSMutableArray array];
    _imageAltTexts = [NSMutableArray array];
    _imageURLs = [NSMutableArray array];
    _listItemRanges = [NSMutableArray array];
    _listItemPositions = [NSMutableArray array];
    _listItemDepths = [NSMutableArray array];
    _listItemOrdered = [NSMutableArray array];
    _mathReporters = [NSMutableArray array];
    _fontCache = [NSMutableDictionary dictionary];
    _currentBlockStyle = [[BlockStyle alloc] init];
    _allowFontScaling = YES;
    _maxFontSizeMultiplier = 0;

    NSMutableParagraphStyle *spacerTemplate = [[NSMutableParagraphStyle alloc] init];
    _baseSpacerTemplate = [spacerTemplate copy];

    NSMutableParagraphStyle *blockSpacerTemplate = [[NSMutableParagraphStyle alloc] init];
    blockSpacerTemplate.minimumLineHeight = 1;
    blockSpacerTemplate.maximumLineHeight = 1;
    _baseBlockSpacerTemplate = [blockSpacerTemplate copy];

    [self reset];
  }
  return self;
}

#pragma mark - Font Cache

- (UIFont *)cachedFontForSize:(CGFloat)fontSize family:(NSString *)fontFamily weight:(NSString *)fontWeight
{
  CGFloat effectiveMultiplier = _allowFontScaling ? RCTFontSizeMultiplierWithMax(_maxFontSizeMultiplier) : 1.0;

  NSString *weightKey = (fontWeight.length > 0) ? fontWeight : @"";
  NSString *key =
      [NSString stringWithFormat:@"%.1f|%@|%@|%.2f", fontSize, fontFamily ?: @"", weightKey, effectiveMultiplier];

  UIFont *cached = _fontCache[key];
  if (cached) {
    return cached;
  }

  NSString *effectiveWeight = (fontWeight.length > 0) ? fontWeight : nil;

  UIFont *font = [RCTFont updateFont:nil
                          withFamily:fontFamily
                                size:@(fontSize)
                              weight:effectiveWeight
                               style:nil
                             variant:nil
                     scaleMultiplier:effectiveMultiplier];

  if (font) {
    _fontCache[key] = font;
  }
  return font;
}

#pragma mark - Paragraph Style Factory

- (NSMutableParagraphStyle *)spacerStyleWithHeight:(CGFloat)height spacing:(CGFloat)spacing
{
  NSMutableParagraphStyle *style = [_baseSpacerTemplate mutableCopy];
  style.minimumLineHeight = height;
  style.maximumLineHeight = height;
  style.paragraphSpacing = spacing;
  return style;
}

- (NSMutableParagraphStyle *)blockSpacerStyleWithMargin:(CGFloat)margin
{
  NSMutableParagraphStyle *style = [_baseBlockSpacerTemplate mutableCopy];
  style.paragraphSpacing = margin;
  return style;
}

#pragma mark - Link Registry

- (void)registerLinkRange:(NSRange)range url:(NSString *)url
{
  if (range.length == 0)
    return;
  [self.linkRanges addObject:[NSValue valueWithRange:range]];
  [self.linkURLs addObject:url ?: @""];
}

- (void)applyLinkAttributesToString:(NSMutableAttributedString *)attributedString
{
  NSUInteger length = attributedString.length;
  for (NSUInteger i = 0; i < self.linkRanges.count; i++) {
    NSRange range = [self.linkRanges[i] rangeValue];
    if (NSMaxRange(range) > length)
      continue;
    [attributedString addAttribute:@"linkURL" value:self.linkURLs[i] range:range];
  }
}

- (void)applyImageAttributesToString:(NSMutableAttributedString *)attributedString
{
  NSUInteger length = attributedString.length;
  for (NSUInteger i = 0; i < self.imageRanges.count; i++) {
    NSRange range = [self.imageRanges[i] rangeValue];
    if (NSMaxRange(range) > length)
      continue;
    [attributedString addAttribute:@"imageURL" value:self.imageURLs[i] range:range];
    [attributedString addAttribute:@"imageAltText" value:self.imageAltTexts[i] range:range];
  }
}

- (void)registerHeadingRange:(NSRange)range level:(NSInteger)level text:(NSString *)text
{
  if (range.length == 0)
    return;
  [self.headingRanges addObject:[NSValue valueWithRange:range]];
  [self.headingLevels addObject:@(level)];
}

- (void)registerImageRange:(NSRange)range altText:(NSString *)altText url:(NSString *)url
{
  if (range.length == 0)
    return;
  [self.imageRanges addObject:[NSValue valueWithRange:range]];
  [self.imageAltTexts addObject:altText ?: @""];
  [self.imageURLs addObject:url ?: @""];
}

#pragma mark - Registration Helpers

- (void)registerListItemRange:(NSRange)range
                     position:(NSInteger)position
                        depth:(NSInteger)depth
                    isOrdered:(BOOL)isOrdered
{
  if (![self isValidRange:range])
    return;

  [self.listItemRanges addObject:[NSValue valueWithRange:range]];
  [self.listItemPositions addObject:@(position)];
  [self.listItemDepths addObject:@(depth)];
  [self.listItemOrdered addObject:@(isOrdered)];
}

#pragma mark - Private

- (BOOL)isValidRange:(NSRange)range
{
  return range.length > 0 && range.location != NSNotFound;
}

#pragma mark - Block Style Management

/**
 * Updates the shared BlockStyle object with new traits.
 * This avoids allocating a new object for every block node in the AST.
 */
- (void)setBlockStyle:(BlockType)type
             fontSize:(CGFloat)fontSize
           fontFamily:(NSString *)fontFamily
           fontWeight:(NSString *)fontWeight
                color:(RCTUIColor *)color
         headingLevel:(NSInteger)headingLevel
{
  _currentBlockType = type;
  _currentHeadingLevel = headingLevel;

  _currentBlockStyle.fontSize = fontSize;
  _currentBlockStyle.fontFamily = fontFamily ?: @"";
  _currentBlockStyle.fontWeight = fontWeight ?: @"normal";
  _currentBlockStyle.color = color ?: [RCTUIColor blackColor];
}

- (void)setBlockStyle:(BlockType)type
             fontSize:(CGFloat)fontSize
           fontFamily:(NSString *)fontFamily
           fontWeight:(NSString *)fontWeight
                color:(RCTUIColor *)color
{
  [self setBlockStyle:type fontSize:fontSize fontFamily:fontFamily fontWeight:fontWeight color:color headingLevel:0];
}

- (void)setBlockStyle:(BlockType)type font:(UIFont *)font color:(RCTUIColor *)color headingLevel:(NSInteger)headingLevel
{
  _currentBlockType = type;
  _currentHeadingLevel = headingLevel;

  RCTUIColor *finalColor = color ?: [RCTUIColor blackColor];
  _currentBlockStyle.cachedFont = font;
  _currentBlockStyle.color = finalColor;

  // Pre-create text attributes dictionary if we have both font and color
  if (font) {
    _currentBlockStyle.cachedTextAttributes =
        @{NSFontAttributeName : font, NSForegroundColorAttributeName : finalColor};
  }
}

- (BlockStyle *)getBlockStyle
{
  return _currentBlockStyle;
}

- (NSDictionary *)getTextAttributes
{
  BlockStyle *style = _currentBlockStyle;

  // Return pre-cached attributes if available
  if (style.cachedTextAttributes) {
    return style.cachedTextAttributes;
  }

  // Fall back to creating attributes from font cache
  UIFont *font = style.cachedFont;
  if (!font) {
    font = [self cachedFontForSize:style.fontSize family:style.fontFamily weight:style.fontWeight];
  }
  RCTUIColor *color = style.color ?: [RCTUIColor blackColor];

  // Cache for future calls within same block
  style.cachedTextAttributes = @{NSFontAttributeName : font, NSForegroundColorAttributeName : color};
  return style.cachedTextAttributes;
}

- (void)clearBlockStyle
{
  _currentBlockType = BlockTypeNone;
  _currentHeadingLevel = 0;
  _currentBlockStyle.cachedFont = nil;
  _currentBlockStyle.cachedTextAttributes = nil;
}

- (id)snapshotScope
{
  NSArray<NSString *> *keyPaths = ENRMScopedKeyPaths();
  NSMutableDictionary *snapshot = [NSMutableDictionary dictionaryWithCapacity:keyPaths.count];
  for (NSString *keyPath in keyPaths) {
    snapshot[keyPath] = [self valueForKeyPath:keyPath] ?: [NSNull null];
  }
  return snapshot;
}

- (void)restoreScope:(id)snapshot
{
  NSDictionary *frame = snapshot;
  for (NSString *keyPath in ENRMScopedKeyPaths()) {
    id value = frame[keyPath];
    [self setValue:(value == [NSNull null] ? nil : value) forKeyPath:keyPath];
  }
}

#pragma mark - Reset

- (void)reset
{
  [_linkRanges removeAllObjects];
  [_linkURLs removeAllObjects];
  [_headingRanges removeAllObjects];
  [_headingLevels removeAllObjects];
  [_imageRanges removeAllObjects];
  [_imageAltTexts removeAllObjects];
  [_imageURLs removeAllObjects];
  [_listItemRanges removeAllObjects];
  [_listItemPositions removeAllObjects];
  [_listItemDepths removeAllObjects];
  [_listItemOrdered removeAllObjects];
  [_mathReporters removeAllObjects];
  [self clearBlockStyle];

  _blockquoteDepth = 0;
  _listDepth = 0;
  _listType = ListTypeUnordered;
  _listItemNumber = 0;
  _accumulatedIndent = 0;
  _taskItemCount = 0;

  // Revert shared style object to baseline defaults
  _currentBlockStyle.fontSize = 0;
  _currentBlockStyle.fontFamily = @"";
  _currentBlockStyle.fontWeight = @"";
  _currentBlockStyle.color = [RCTUIColor blackColor];
}

#pragma mark - Static Utilities

/**
 * Determines if specific inline attributes should protect the current color.
 */
+ (BOOL)shouldPreserveColors:(NSDictionary *)attrs
{
  return (attrs[NSLinkAttributeName] != nil || attrs[CodeAttributeName] != nil);
}

// TODO: Unify calculateStrongColor and calculateHighlightColor into a single helper that
// resolves inline foreground color from (configColor, inheritanceBaseline, blockColor).

/**
 * Calculates whether a strong color should override the block color.
 */
+ (RCTUIColor *)calculateStrongColor:(RCTUIColor *)configStrongColor blockColor:(RCTUIColor *)blockColor
{
  if (!configStrongColor || [configStrongColor isEqual:blockColor]) {
    return blockColor;
  }
  return configStrongColor;
}

+ (RCTUIColor *)calculateHighlightColor:(RCTUIColor *)configHighlightColor
                         paragraphColor:(RCTUIColor *)paragraphColor
                             blockColor:(RCTUIColor *)blockColor
{
  if ([configHighlightColor isEqual:paragraphColor]) {
    return blockColor;
  }
  return configHighlightColor;
}

/**
 * Safely calculates a range based on a start point and the current output length.
 */
+ (NSRange)rangeForRenderedContent:(NSMutableAttributedString *)output start:(NSUInteger)start
{
  if (output.length < start)
    return NSMakeRange(start, 0);
  return NSMakeRange(start, output.length - start);
}

/**
 * Surgically applies attributes only if they differ from current values.
 * This minimizes "dirtying" the AttributedString, which improves layout performance.
 */
+ (void)applyFontAndColorAttributes:(NSMutableAttributedString *)output
                              range:(NSRange)range
                               font:(UIFont *)font
                              color:(RCTUIColor *)color
                 existingAttributes:(NSDictionary *)attrs
               shouldPreserveColors:(BOOL)shouldPreserve
{
  if (range.length == 0)
    return;

  // Font Update: Only if it exists and is different
  if (font && ![font isEqual:attrs[NSFontAttributeName]]) {
    [output addAttribute:NSFontAttributeName value:font range:range];
  }

  // Color Update: Only if not a link/code and different from existing
  if (color && !shouldPreserve && ![color isEqual:attrs[NSForegroundColorAttributeName]]) {
    [output addAttribute:NSForegroundColorAttributeName value:color range:range];
  }
}

@end