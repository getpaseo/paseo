#import "BlockquoteBorder.h"
#import "ParagraphStyleUtils.h"
#import "StyleConfig.h"

// Attribute constants for identifying blockquote segments in text storage
NSString *const BlockquoteDepthAttributeName = @"BlockquoteDepth";
NSString *const BlockquoteBackgroundColorAttributeName = @"BlockquoteBackgroundColor";
NSString *const BlockquoteSpacerAttributeName = @"BlockquoteSpacer";

@implementation BlockquoteBorder {
  StyleConfig *_config;
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  if (self = [super init]) {
    _config = config;
  }
  return self;
}

/**
 * Main drawing entry point called by the LayoutManager.
 * Collects contiguous blockquote regions and draws each as one rounded box:
 * background fill first, then the vertical borders clipped to the box shape.
 * When a border radius is set, each nested quote's stripes are additionally
 * clipped to that quote's own rounded box, mirroring per-element CSS
 * border-radius on web.
 * Regions are discovered by scanning only the drawn character range; regions
 * touching its edges are extended run-by-run to their true boundaries, so the
 * cost scales with the visible text plus the intersecting quotes rather than
 * the whole document.
 */
- (void)drawBordersForGlyphRange:(NSRange)glyphsToShow
                   layoutManager:(NSLayoutManager *)layoutManager
                   textContainer:(NSTextContainer *)textContainer
                         atPoint:(CGPoint)origin
{
  NSTextStorage *textStorage = layoutManager.textStorage;
  if (!textStorage || textStorage.length == 0) {
    return;
  }

  NSRange charRange = [layoutManager characterRangeForGlyphRange:glyphsToShow actualGlyphRange:NULL];
  if (charRange.location == NSNotFound || charRange.length == 0) {
    return;
  }

  NSMutableArray<NSValue *> *regions = [NSMutableArray array];
  __block NSRange currentRegion = NSMakeRange(NSNotFound, 0);
  [textStorage enumerateAttribute:BlockquoteDepthAttributeName
                          inRange:charRange
                          options:0
                       usingBlock:^(id value, NSRange range, BOOL *stop) {
                         if (!value) {
                           if (currentRegion.location != NSNotFound) {
                             [regions addObject:[NSValue valueWithRange:currentRegion]];
                             currentRegion = NSMakeRange(NSNotFound, 0);
                           }
                           return;
                         }
                         currentRegion =
                             currentRegion.location == NSNotFound ? range : NSUnionRange(currentRegion, range);
                       }];
  if (currentRegion.location != NSNotFound) {
    [regions addObject:[NSValue valueWithRange:currentRegion]];
  }

  if (regions.count == 0) {
    return;
  }

  NSRange firstRegion = regions.firstObject.rangeValue;
  if (firstRegion.location == charRange.location) {
    while (firstRegion.location > 0) {
      NSRange runRange;
      if (![textStorage attribute:BlockquoteDepthAttributeName
                          atIndex:firstRegion.location - 1
                   effectiveRange:&runRange]) {
        break;
      }
      firstRegion = NSUnionRange(firstRegion, runRange);
    }
    regions[0] = [NSValue valueWithRange:firstRegion];
  }

  NSRange lastRegion = regions.lastObject.rangeValue;
  if (NSMaxRange(lastRegion) == NSMaxRange(charRange)) {
    while (NSMaxRange(lastRegion) < textStorage.length) {
      NSRange runRange;
      if (![textStorage attribute:BlockquoteDepthAttributeName
                          atIndex:NSMaxRange(lastRegion)
                   effectiveRange:&runRange]) {
        break;
      }
      lastRegion = NSUnionRange(lastRegion, runRange);
    }
    regions[regions.count - 1] = [NSValue valueWithRange:lastRegion];
  }

  for (NSValue *value in regions) {
    [self drawBlockquoteRegion:value.rangeValue layoutManager:layoutManager textContainer:textContainer atPoint:origin];
  }
}

/**
 * Groups the depth runs of a region into nested quote boxes: for each level
 * >= 1, a box is a maximal contiguous stretch where depth >= level (a nested
 * quote's own range). Outputs parallel arrays of ranges and levels.
 */
static void collectNestedBoxes(NSArray<NSValue *> *runRanges, NSArray<NSNumber *> *runDepths,
                               NSMutableArray<NSValue *> *boxRanges, NSMutableArray<NSNumber *> *boxLevels)
{
  NSInteger maxDepth = 0;
  for (NSNumber *depth in runDepths) {
    maxDepth = MAX(maxDepth, depth.integerValue);
  }

  for (NSInteger level = 1; level <= maxDepth; level++) {
    NSRange current = NSMakeRange(NSNotFound, 0);
    for (NSUInteger i = 0; i < runRanges.count; i++) {
      if (runDepths[i].integerValue >= level) {
        NSRange runRange = runRanges[i].rangeValue;
        current = current.location == NSNotFound ? runRange : NSUnionRange(current, runRange);
      } else if (current.location != NSNotFound) {
        [boxRanges addObject:[NSValue valueWithRange:current]];
        [boxLevels addObject:@(level)];
        current = NSMakeRange(NSNotFound, 0);
      }
    }
    if (current.location != NSNotFound) {
      [boxRanges addObject:[NSValue valueWithRange:current]];
      [boxLevels addObject:@(level)];
    }
  }
}

- (void)drawBlockquoteRegion:(NSRange)region
               layoutManager:(NSLayoutManager *)layoutManager
               textContainer:(NSTextContainer *)textContainer
                     atPoint:(CGPoint)origin
{
  NSTextStorage *textStorage = layoutManager.textStorage;

  // Cache configuration values to minimize pointer chasing and method lookups in the loop
  StyleConfig *c = _config;
  CGFloat borderWidth = c.blockquoteBorderWidth;
  CGFloat gapWidth = c.blockquoteGapWidth;
  CGFloat levelSpacing = borderWidth + gapWidth;
  CGFloat borderRadius = c.blockquoteBorderRadius;
  CGFloat containerWidth = textContainer.size.width;
  RCTUIColor *defaultBgColor = c.blockquoteBackgroundColor;
  RCTUIColor *borderColor = c.blockquoteBorderColor;

  NSRange glyphRange = [layoutManager glyphRangeForCharacterRange:region actualCharacterRange:NULL];
  CGRect blockRect = [layoutManager boundingRectForGlyphRange:glyphRange inTextContainer:textContainer];
  if (CGRectIsEmpty(blockRect)) {
    return;
  }

  blockRect.origin.x = origin.x;
  blockRect.origin.y += origin.y;
  blockRect.size.width = containerWidth;

  BOOL isLastBlockquote = (NSMaxRange(region) == textStorage.length);
  if (isLastBlockquote) {
    blockRect.size.height += c.blockquotePadding;
  }

  NSMutableArray<NSValue *> *boxRanges = [NSMutableArray array];
  NSMutableArray<NSNumber *> *boxLevels = [NSMutableArray array];
  NSMutableArray<UIBezierPath *> *boxStripePaths = [NSMutableArray array];
  if (borderRadius > 0) {
    NSMutableArray<NSValue *> *runRanges = [NSMutableArray array];
    NSMutableArray<NSNumber *> *runDepths = [NSMutableArray array];
    [textStorage enumerateAttribute:BlockquoteDepthAttributeName
                            inRange:region
                            options:0
                         usingBlock:^(id value, NSRange range, BOOL *stop) {
                           if (!value) {
                             return;
                           }
                           [runRanges addObject:[NSValue valueWithRange:range]];
                           [runDepths addObject:value];
                         }];
    collectNestedBoxes(runRanges, runDepths, boxRanges, boxLevels);
    for (NSUInteger i = 0; i < boxRanges.count; i++) {
      [boxStripePaths addObject:[UIBezierPath bezierPath]];
    }
  }

  CGContextRef ctx = UIGraphicsGetCurrentContext();
  CGContextSaveGState(ctx);
  {
    UIBezierPath *boxPath = UIBezierPathWithRoundedRect(blockRect, MAX(0, borderRadius));
    [boxPath addClip];

    // 1. Draw Background (Painter's algorithm: draw backgrounds before borders)
    RCTUIColor *bgColor = [textStorage attribute:BlockquoteBackgroundColorAttributeName
                                         atIndex:region.location
                                  effectiveRange:NULL]
                              ?: defaultBgColor;
    if (bgColor && bgColor != [RCTUIColor clearColor]) {
      [bgColor setFill];
      CGContextFillRect(ctx, blockRect);
    }

    // 2. Aggregate vertical borders into batch paths; level-0 stripes are
    // rounded by the region clip, nested stripes by their own box clip below
    UIBezierPath *borderPath = [UIBezierPath bezierPath];
    [layoutManager
        enumerateLineFragmentsForGlyphRange:glyphRange
                                 usingBlock:^(CGRect rect, CGRect usedRect, NSTextContainer *container,
                                              NSRange lineGlyphRange, BOOL *stop) {
                                   NSRange lineCharRange = [layoutManager characterRangeForGlyphRange:lineGlyphRange
                                                                                     actualGlyphRange:NULL];
                                   if (lineCharRange.location == NSNotFound || lineCharRange.length == 0) {
                                     return;
                                   }

                                   NSDictionary *attrs = [textStorage attributesAtIndex:lineCharRange.location
                                                                         effectiveRange:NULL];
                                   NSNumber *depthNum = attrs[BlockquoteDepthAttributeName];

                                   if (!depthNum) {
                                     return;
                                   }

                                   NSInteger depth = [depthNum integerValue];
                                   CGFloat baseY = origin.y + rect.origin.y;
                                   CGFloat lineHeight = rect.size.height;
                                   BOOL isLastLine = NSMaxRange(lineGlyphRange) == NSMaxRange(glyphRange);
                                   if (isLastBlockquote && isLastLine) {
                                     lineHeight += c.blockquotePadding;
                                   }
                                   BOOL isRTL = ENRMParagraphIsRTL(attrs[NSParagraphStyleAttributeName]);

                                   for (NSInteger level = 0; level <= depth; level++) {
                                     CGFloat borderX =
                                         isRTL ? origin.x + containerWidth - borderWidth - (levelSpacing * level)
                                               : origin.x + (levelSpacing * level);
                                     CGRect borderRect = CGRectMake(borderX, baseY, borderWidth, lineHeight);

                                     UIBezierPath *target = borderPath;
                                     for (NSUInteger b = 0; b < boxRanges.count; b++) {
                                       if (boxLevels[b].integerValue == level &&
                                           NSLocationInRange(lineCharRange.location, boxRanges[b].rangeValue)) {
                                         target = boxStripePaths[b];
                                         break;
                                       }
                                     }
                                     UIBezierPathAppendPath(target, [UIBezierPath bezierPathWithRect:borderRect]);
                                   }
                                 }];

    // 3. Perform a single batch fill for the root-level borders
    if (!borderPath.isEmpty) {
      [borderColor setFill];
      [borderPath fill];
    }

    // 4. Nested stripes: clip each to its own quote's rounded box (the clips
    // compose with the still-active region clip)
    for (NSUInteger b = 0; b < boxRanges.count; b++) {
      UIBezierPath *stripes = boxStripePaths[b];
      if (stripes.isEmpty) {
        continue;
      }

      NSRange boxRange = boxRanges[b].rangeValue;
      NSRange boxGlyphRange = [layoutManager glyphRangeForCharacterRange:boxRange actualCharacterRange:NULL];
      CGRect boxRect = [layoutManager boundingRectForGlyphRange:boxGlyphRange inTextContainer:textContainer];
      if (CGRectIsEmpty(boxRect)) {
        continue;
      }

      NSDictionary *boxAttrs = [textStorage attributesAtIndex:boxRange.location effectiveRange:NULL];
      BOOL boxRTL = ENRMParagraphIsRTL(boxAttrs[NSParagraphStyleAttributeName]);
      CGFloat leadingInset = levelSpacing * boxLevels[b].integerValue;
      boxRect.origin.x = boxRTL ? origin.x : origin.x + leadingInset;
      boxRect.origin.y += origin.y;
      boxRect.size.width = containerWidth - leadingInset;

      CGContextSaveGState(ctx);
      [UIBezierPathWithRoundedRect(boxRect, borderRadius) addClip];
      [borderColor setFill];
      [stripes fill];
      CGContextRestoreGState(ctx);
    }
  }
  CGContextRestoreGState(ctx);
}

@end
