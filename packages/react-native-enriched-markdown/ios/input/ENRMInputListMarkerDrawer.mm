#import "ENRMInputListMarkerDrawer.h"
#import "ENRMInputBlockType.h"
#import "ParagraphStyleUtils.h"

static UIFont *ENRMFallbackFont(void)
{
  return [UIFont systemFontOfSize:16];
}

static RCTUIColor *ENRMFallbackColor(void)
{
  return [RCTUIColor labelColor];
}

static CGFloat ENRMTrailingMarkerX(CGPoint origin, NSTextContainer *container, CGFloat leadingOffset)
{
  return origin.x + container.size.width - leadingOffset;
}

@interface ENRMInputListMarkerDrawer ()
- (void)drawTrailingBulletMarkerInRect:(CGRect)bounds;
@end

#if !TARGET_OS_OSX

#pragma mark - Trailing bullet overlay

/// A lightweight overlay that draws the trailing empty line's list marker.
/// drawGlyphsForGlyphRange: clips its context to the glyph area, which excludes
/// the extra line fragment.  A subview is immune to that clipping.
@interface ENRMTrailingBulletView : UIView
@property (nonatomic, weak) ENRMInputListMarkerDrawer *drawer;
@end

@implementation ENRMTrailingBulletView

- (void)drawRect:(CGRect)rect
{
  [_drawer drawTrailingBulletMarkerInRect:self.bounds];
}

@end

#endif

#pragma mark -

@implementation ENRMInputListMarkerDrawer {
  NSMutableSet<NSNumber *> *_drawnParagraphLocations;
#if !TARGET_OS_OSX
  ENRMTrailingBulletView *_trailingBulletView;
  __weak NSTextContainer *_trailingBulletTextContainer;
  CGFloat _trailingBulletInsetLeft;
  CGFloat _trailingBulletHeadIndent;
#endif
}

- (instancetype)init
{
  if (self = [super init]) {
    _emptyBulletDepth = -1;
    _drawnParagraphLocations = [NSMutableSet set];
  }
  return self;
}

#pragma mark - Primitive Drawing

- (void)drawBulletAtX:(CGFloat)markerX
              centerY:(CGFloat)centerY
                depth:(NSInteger)depth
                 font:(UIFont *)font
                color:(RCTUIColor *)color
{
  CGContextRef ctx = UIGraphicsGetCurrentContext();
  if (!ctx || isnan(markerX) || isnan(centerY)) {
    return;
  }

  CGFloat size = MAX(4.0, font.pointSize * 0.30);
  CGRect bulletRect = CGRectMake(markerX - size / 2.0, centerY - size / 2.0, size, size);

  CGContextSaveGState(ctx);
  NSInteger style = depth >= 2 ? 2 : depth;
  switch (style) {
    case 0:
      [color setFill];
      CGContextFillEllipseInRect(ctx, bulletRect);
      break;
    case 1: {
      CGFloat lineWidth = MAX(1.0, size * 0.15);
      [color setStroke];
      CGContextSetLineWidth(ctx, lineWidth);
      CGContextStrokeEllipseInRect(ctx, CGRectInset(bulletRect, lineWidth / 2.0, lineWidth / 2.0));
      break;
    }
    default:
      [color setFill];
      CGContextFillRect(ctx, bulletRect);
      break;
  }
  CGContextRestoreGState(ctx);
}

- (void)drawOrderedMarkerEndingAtX:(CGFloat)markerRight
                         baselineY:(CGFloat)baselineY
                           ordinal:(NSInteger)ordinal
                              font:(UIFont *)font
                             color:(RCTUIColor *)color
{
  NSString *label = [NSString stringWithFormat:@"%ld.", (long)MAX(ordinal, (NSInteger)1)];
  NSDictionary *attrs = @{NSFontAttributeName : font, NSForegroundColorAttributeName : color};
  CGSize labelSize = [label sizeWithAttributes:attrs];
  [label drawAtPoint:CGPointMake(markerRight - labelSize.width, baselineY - font.ascender) withAttributes:attrs];
}

- (void)drawOrderedMarkerStartingAtX:(CGFloat)markerLeft
                           baselineY:(CGFloat)baselineY
                             ordinal:(NSInteger)ordinal
                                font:(UIFont *)font
                               color:(RCTUIColor *)color
{
  NSString *label = [NSString stringWithFormat:@".%ld", (long)MAX(ordinal, (NSInteger)1)];
  NSDictionary *attrs = @{NSFontAttributeName : font, NSForegroundColorAttributeName : color};
  [label drawAtPoint:CGPointMake(markerLeft, baselineY - font.ascender) withAttributes:attrs];
}

#pragma mark - Composite Marker

- (void)drawListMarkerOrdered:(BOOL)isOrdered
                        depth:(NSInteger)depth
                      ordinal:(NSInteger)ordinal
                          rtl:(BOOL)isRTL
                    baselineY:(CGFloat)baselineY
                       origin:(CGPoint)origin
                     usedRect:(CGRect)usedRect
                    container:(NSTextContainer *)container
                         font:(UIFont *)font
                        color:(RCTUIColor *)color
{
  CGFloat leadingOffset = container.lineFragmentPadding + (depth + 1) * kENRMListIndentPerDepth;

  if (isOrdered) {
    if (isRTL) {
      CGFloat anchorX = ENRMTrailingMarkerX(origin, container, leadingOffset) + kENRMListBulletGap / 2.0;
      [self drawOrderedMarkerStartingAtX:anchorX baselineY:baselineY ordinal:ordinal font:font color:color];
    } else {
      CGFloat anchorX = origin.x + usedRect.origin.x - kENRMListBulletGap / 2.0;
      [self drawOrderedMarkerEndingAtX:anchorX baselineY:baselineY ordinal:ordinal font:font color:color];
    }
    return;
  }

  CGFloat markerX = isRTL ? ENRMTrailingMarkerX(origin, container, leadingOffset) + kENRMListBulletGap
                          : origin.x + usedRect.origin.x - kENRMListBulletGap;
  CGFloat centerY = baselineY - (font.xHeight + font.capHeight) / 4.0;
  [self drawBulletAtX:markerX centerY:centerY depth:depth font:font color:color];
}

#pragma mark - Attribute Resolution

- (BOOL)readListAttributesAtIndex:(NSUInteger)charIndex
                          storage:(NSTextStorage *)storage
                        paraStart:(NSUInteger)paraStart
                        isOrdered:(out BOOL *)outOrdered
                            depth:(out NSInteger *)outDepth
                          ordinal:(out NSInteger *)outOrdinal
{
  if (charIndex >= storage.length) {
    return NO;
  }

  NSNumber *type = [storage attribute:ENRMBlockTypeAttributeName atIndex:charIndex effectiveRange:NULL];
  if (!type || !ENRMBlockTypeIsListItem((ENRMInputBlockType)type.integerValue) || charIndex != paraStart) {
    return NO;
  }

  *outOrdered = (type.integerValue == ENRMInputBlockTypeOrderedListItem);

  NSNumber *depthValue = [storage attribute:ENRMBlockLevelAttributeName atIndex:charIndex effectiveRange:NULL];
  *outDepth = depthValue ? depthValue.integerValue : 0;

  NSNumber *ordinalValue = [storage attribute:ENRMBlockOrdinalAttributeName atIndex:charIndex effectiveRange:NULL];
  *outOrdinal = ordinalValue ? ordinalValue.integerValue : 1;

  return YES;
}

- (void)resolveMarkerFont:(out UIFont **)outFont
                    color:(out RCTUIColor **)outColor
                  atIndex:(NSUInteger)charIndex
                  storage:(NSTextStorage *)storage
          isEmptyListLine:(BOOL)isEmptyListLine
{
  UIFont *font = nil;
  RCTUIColor *color = nil;

  if (isEmptyListLine) {
    font = self.emptyBulletFont;
    color = self.emptyBulletColor;
  }
  if (!font && charIndex < storage.length) {
    font = [storage attribute:NSFontAttributeName atIndex:charIndex effectiveRange:NULL];
  }
  if (!color && charIndex < storage.length) {
    color = [storage attribute:NSForegroundColorAttributeName atIndex:charIndex effectiveRange:NULL];
  }

  *outFont = font ?: ENRMFallbackFont();
  *outColor = color ?: ENRMFallbackColor();
}

#pragma mark - Fragment Processing

- (void)processLineFragmentRect:(CGRect)rect
                       usedRect:(CGRect)usedRect
                      container:(NSTextContainer *)container
                     glyphRange:(NSRange)glyphRange
                         origin:(CGPoint)origin
                  layoutManager:(NSLayoutManager *)layoutManager
                        storage:(NSTextStorage *)storage
                         string:(NSString *)string
{
  NSRange charRange = [layoutManager characterRangeForGlyphRange:glyphRange actualGlyphRange:NULL];
  if (charRange.location == NSNotFound) {
    return;
  }

  NSRange paraRange = (charRange.location < string.length) ? [string paragraphRangeForRange:charRange]
                                                           : NSMakeRange(charRange.location, 0);

  if ([_drawnParagraphLocations containsObject:@(paraRange.location)]) {
    return;
  }

  BOOL isOrdered = NO;
  NSInteger depth = 0;
  NSInteger ordinal = 1;
  BOOL isAttributedListLine = [self readListAttributesAtIndex:charRange.location
                                                      storage:storage
                                                    paraStart:paraRange.location
                                                    isOrdered:&isOrdered
                                                        depth:&depth
                                                      ordinal:&ordinal];

  BOOL isEmptyListLine =
      !isAttributedListLine && self.emptyBulletDepth >= 0 && charRange.location == self.emptyBulletLocation;
  if (isEmptyListLine) {
    depth = self.emptyBulletDepth;
    isOrdered = self.emptyBulletOrdered;
    ordinal = self.emptyBulletOrdinal;
  }

  if (!isAttributedListLine && !isEmptyListLine) {
    return;
  }
  [_drawnParagraphLocations addObject:@(paraRange.location)];

  UIFont *font;
  RCTUIColor *color;
  [self resolveMarkerFont:&font
                    color:&color
                  atIndex:charRange.location
                  storage:storage
          isEmptyListLine:isEmptyListLine];

  CGFloat baselineOffset = isEmptyListLine ? self.listItemSpacing + font.ascender
                                           : [layoutManager locationForGlyphAtIndex:glyphRange.location].y;
  CGFloat baselineY = origin.y + rect.origin.y + baselineOffset;

  BOOL isRTL = isEmptyListLine ? self.emptyBulletRTL
                               : ENRMParagraphIsRTL([storage attribute:NSParagraphStyleAttributeName
                                                               atIndex:charRange.location
                                                        effectiveRange:NULL]);

  [self drawListMarkerOrdered:isOrdered
                        depth:depth
                      ordinal:ordinal
                          rtl:isRTL
                    baselineY:baselineY
                       origin:origin
                     usedRect:usedRect
                    container:container
                         font:font
                        color:color];
}

#pragma mark - ENRMInputDecorationDrawer

- (void)drawDecorationsForGlyphRange:(NSRange)glyphRange
                       layoutManager:(NSLayoutManager *)layoutManager
                             atPoint:(CGPoint)origin
{
  NSTextStorage *storage = layoutManager.textStorage;
  NSString *string = storage.string;
  [_drawnParagraphLocations removeAllObjects];

  [layoutManager enumerateLineFragmentsForGlyphRange:glyphRange
                                          usingBlock:^(CGRect rect, CGRect usedRect, NSTextContainer *container,
                                                       NSRange fragmentGlyphRange, __unused BOOL *stop) {
                                            [self processLineFragmentRect:rect
                                                                 usedRect:usedRect
                                                                container:container
                                                               glyphRange:fragmentGlyphRange
                                                                   origin:origin
                                                            layoutManager:layoutManager
                                                                  storage:storage
                                                                   string:string];
                                          }];

#if TARGET_OS_OSX
  if (self.emptyBulletDepth >= 0 && self.emptyBulletLocation >= storage.length &&
      layoutManager.extraLineFragmentTextContainer != nil) {
    UIFont *font = self.emptyBulletFont ?: ENRMFallbackFont();
    RCTUIColor *color = self.emptyBulletColor ?: ENRMFallbackColor();
    CGRect used = layoutManager.extraLineFragmentUsedRect;
    CGFloat baselineY = origin.y + used.origin.y + font.ascender;
    [self drawListMarkerOrdered:self.emptyBulletOrdered
                          depth:self.emptyBulletDepth
                        ordinal:self.emptyBulletOrdinal
                            rtl:self.emptyBulletRTL
                      baselineY:baselineY
                         origin:origin
                       usedRect:used
                      container:layoutManager.extraLineFragmentTextContainer
                           font:font
                          color:color];
  }
#endif
}

- (void)drawEmptyEditorDecorationsWithInset:(UIEdgeInsets)inset layoutManager:(NSLayoutManager *)layoutManager
{
  if (self.emptyBulletDepth < 0) {
    return;
  }

  UIFont *font = self.emptyBulletFont ?: ENRMFallbackFont();
  RCTUIColor *color = self.emptyBulletColor ?: ENRMFallbackColor();
  NSTextContainer *container = layoutManager.textContainers.firstObject;
  BOOL isRTL = self.emptyBulletRTL && container != nil;

  CGFloat headIndent = (self.emptyBulletDepth + 1) * kENRMListIndentPerDepth;
  CGFloat padding = container ? container.lineFragmentPadding : 0;
  CGRect syntheticUsedRect = CGRectMake(padding + headIndent, 0, 0, 0);
  CGPoint syntheticOrigin = CGPointMake(inset.left, 0);
  NSTextContainer *drawContainer = container ?: [[NSTextContainer alloc] initWithSize:CGSizeMake(0, CGFLOAT_MAX)];

  CGFloat baselineY = inset.top + font.ascender;

  [self drawListMarkerOrdered:self.emptyBulletOrdered
                        depth:self.emptyBulletDepth
                      ordinal:self.emptyBulletOrdinal
                          rtl:isRTL
                    baselineY:baselineY
                       origin:syntheticOrigin
                     usedRect:syntheticUsedRect
                    container:drawContainer
                         font:font
                        color:color];
}

#if !TARGET_OS_OSX

#pragma mark - Trailing Bullet Overlay

- (void)drawTrailingBulletMarkerInRect:(CGRect)bounds
{
  if (self.emptyBulletDepth < 0 || !_trailingBulletTextContainer) {
    return;
  }

  UIFont *font = self.emptyBulletFont ?: ENRMFallbackFont();
  RCTUIColor *color = self.emptyBulletColor ?: ENRMFallbackColor();

  CGRect usedRect = CGRectMake(_trailingBulletHeadIndent, 0, 0, bounds.size.height);
  CGPoint origin = CGPointMake(_trailingBulletInsetLeft, 0);

  [self drawListMarkerOrdered:self.emptyBulletOrdered
                        depth:self.emptyBulletDepth
                      ordinal:self.emptyBulletOrdinal
                          rtl:self.emptyBulletRTL
                    baselineY:font.ascender
                       origin:origin
                     usedRect:usedRect
                    container:_trailingBulletTextContainer
                         font:font
                        color:color];
}

- (void)showTrailingBulletInTextView:(UITextView *)textView
                       textContainer:(NSTextContainer *)container
                            usedRect:(CGRect)usedRect
{
  if (!_trailingBulletView) {
    _trailingBulletView = [[ENRMTrailingBulletView alloc] init];
    _trailingBulletView.backgroundColor = [RCTUIColor clearColor];
    _trailingBulletView.opaque = NO;
    _trailingBulletView.userInteractionEnabled = NO;
  }

  if (_trailingBulletView.superview != textView) {
    [_trailingBulletView removeFromSuperview];
    [textView addSubview:_trailingBulletView];
  }

  UIEdgeInsets inset = textView.textContainerInset;
  _trailingBulletView.frame =
      CGRectMake(0, inset.top + usedRect.origin.y, textView.bounds.size.width, usedRect.size.height);
  _trailingBulletView.drawer = self;
  _trailingBulletTextContainer = container;
  _trailingBulletInsetLeft = inset.left;
  _trailingBulletHeadIndent = usedRect.origin.x;
  _trailingBulletView.hidden = NO;
  [textView bringSubviewToFront:_trailingBulletView];
  [_trailingBulletView setNeedsDisplay];
}

- (void)hideTrailingBullet
{
  _trailingBulletView.hidden = YES;
}

#endif

@end
