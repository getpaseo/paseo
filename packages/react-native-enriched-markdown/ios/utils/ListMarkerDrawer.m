#import "ListMarkerDrawer.h"
#import "ENRMUIKit.h"
#import "ListItemRenderer.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "StyleConfig.h"

extern NSString *const ListItemMarkerStartAttribute;

static NSString *const kAppleColorEmojiFontName = @"AppleColorEmoji";

@implementation ListMarkerDrawer {
  StyleConfig *_config;
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  if (self = [super init]) {
    _config = config;
  }
  return self;
}

- (void)drawMarkersForGlyphRange:(NSRange)glyphsToShow
                   layoutManager:(NSLayoutManager *)layoutManager
                   textContainer:(NSTextContainer *)textContainer
                         atPoint:(CGPoint)origin
{
  NSTextStorage *storage = layoutManager.textStorage;
  if (!storage || storage.length == 0)
    return;

  CGFloat gap = [_config effectiveListGapWidth];
  NSMutableSet *drawnParagraphs = [NSMutableSet set];

  [layoutManager
      enumerateLineFragmentsForGlyphRange:glyphsToShow
                               usingBlock:^(CGRect rect, CGRect usedRect, NSTextContainer *container,
                                            NSRange glyphRange, BOOL *stop) {
                                 NSRange charRange = [layoutManager characterRangeForGlyphRange:glyphRange
                                                                               actualGlyphRange:NULL];
                                 if (charRange.location == NSNotFound)
                                   return;

                                 NSDictionary *attrs = [storage attributesAtIndex:charRange.location
                                                                   effectiveRange:NULL];
                                 NSArray *markers = attrs[ListItemMarkerStartAttribute];
                                 if (![markers isKindOfClass:[NSArray class]] || markers.count == 0)
                                   return;

                                 // Identify the start of the paragraph
                                 NSRange paraRange = [storage.string paragraphRangeForRange:charRange];
                                 if (charRange.location != paraRange.location ||
                                     [drawnParagraphs containsObject:@(paraRange.location)])
                                   return;
                                 [drawnParagraphs addObject:@(paraRange.location)];

                                 BOOL isRTL = ENRMParagraphIsRTL(attrs[NSParagraphStyleAttributeName]);

                                 CGPoint glyphLoc = [layoutManager locationForGlyphAtIndex:glyphRange.location];
                                 CGFloat baselineY = origin.y + rect.origin.y + glyphLoc.y;

                                 // TextKit places an attachment glyph at the bottom edge of its
                                 // bounds, not on the baseline. An item that starts with a link
                                 // pill, an inline image or inline math would otherwise push its
                                 // marker down by however far the attachment hangs below the text.
                                 NSTextAttachment *attachment = attrs[NSAttachmentAttributeName];
                                 if ([attachment isKindOfClass:[NSTextAttachment class]]) {
                                   baselineY += [attachment attachmentBoundsForTextContainer:container
                                                                        proposedLineFragment:rect
                                                                               glyphPosition:glyphLoc
                                                                              characterIndex:charRange.location]
                                                    .origin.y;
                                 }

                                 // When the anchor character is an emoji, NSFontAttributeName
                                 // returns AppleColorEmoji whose metrics (xHeight, capHeight)
                                 // differ widely from the text font and would misplace the
                                 // marker. Look past the first composed character sequence
                                 // to find the actual text font used on the line.
                                 UIFont *font = attrs[NSFontAttributeName];
                                 if (charRange.length > 1) {
                                   NSRange firstGrapheme =
                                       [storage.string rangeOfComposedCharacterSequenceAtIndex:charRange.location];
                                   NSUInteger afterFirst = NSMaxRange(firstGrapheme);
                                   if (afterFirst < NSMaxRange(charRange)) {
                                     UIFont *textFont = [storage attribute:NSFontAttributeName
                                                                   atIndex:afterFirst
                                                            effectiveRange:NULL];
                                     if (textFont) {
                                       font = textFont;
                                     }
                                   }
                                 }
                                 if (!font || [font.fontName isEqualToString:kAppleColorEmojiFontName]) {
                                   font = [self defaultFont];
                                 }

                                 for (ENRMListMarkerDescriptor *marker in markers) {
                                   CGFloat markerX = isRTL ? origin.x + container.size.width - marker.indent + gap
                                                           : origin.x + marker.indent - gap;

                                   if (marker.isTask) {
                                     const CGFloat size = [_config taskListCheckboxSize];
                                     CGFloat checkboxX = isRTL ? markerX + size / 2.0 : markerX - size / 2.0;
                                     [self drawCheckboxAtX:checkboxX
                                                   centerY:baselineY - (font.capHeight / 2.0)
                                                   checked:marker.isChecked];
                                   } else if (marker.listType == ListTypeUnordered) {
                                     [self drawBulletAtX:markerX
                                                 centerY:baselineY - (font.xHeight + font.capHeight) / 4.0
                                                   depth:marker.depth];
                                   } else {
                                     [self drawOrderedMarkerAtX:markerX
                                                         number:marker.number
                                                      baselineY:baselineY
                                                          isRTL:isRTL];
                                   }
                                 }
                               }];
}

#pragma mark - Drawing Helpers

- (void)drawCheckboxAtX:(CGFloat)x centerY:(CGFloat)y checked:(BOOL)checked
{
  const CGFloat size = [_config taskListCheckboxSize];
  const CGFloat radius = [_config taskListCheckboxBorderRadius];
  const CGRect rect = CGRectMake(x - size / 2.0, y - size / 2.0, size, size);

  [self
      executeDrawing:^(CGContextRef ctx) {
        UIBezierPath *borderPath = UIBezierPathWithRoundedRect(rect, radius);

        if (checked) {
          [[_config taskListCheckedColor] setFill];
          [borderPath fill];

          [self drawCheckmarkInsideRect:rect size:size];
        } else {
          CGFloat lineWidth = MAX(1.0, size * 0.09);
          CGRect insetRect = CGRectInset(rect, lineWidth / 2.0, lineWidth / 2.0);
          UIBezierPath *insetPath = UIBezierPathWithRoundedRect(insetRect, radius);
          insetPath.lineWidth = lineWidth;
          [[_config taskListBorderColor] setStroke];
          [insetPath stroke];
        }
      }
                 atX:x
                   y:y];
}

- (void)drawCheckmarkInsideRect:(CGRect)rect size:(CGFloat)size
{
  const CGFloat inset = size * 0.22;
  const CGFloat verticalMid = CGRectGetMidY(rect);
  const CGFloat horizontalMidOffset = size * 0.05;

  UIBezierPath *checkmark = [UIBezierPath bezierPath];

  [checkmark moveToPoint:CGPointMake(rect.origin.x + inset, verticalMid)];

  BezierPathAddLine(checkmark, CGPointMake(CGRectGetMidX(rect) - horizontalMidOffset, CGRectGetMaxY(rect) - inset));
  BezierPathAddLine(checkmark, CGPointMake(CGRectGetMaxX(rect) - inset, rect.origin.y + inset));

  checkmark.lineWidth = MAX(1.5, size * 0.12);
  BezierPathSetRoundStyle(checkmark);

  [[_config taskListCheckmarkColor] setStroke];
  [checkmark stroke];
}

- (void)drawBulletAtX:(CGFloat)x centerY:(CGFloat)y depth:(NSInteger)depth
{
  CGFloat size = [_config listStyleBulletSize];
  CGRect rect = CGRectMake(x - size / 2.0, y - size / 2.0, size, size);
  [self
      executeDrawing:^(CGContextRef ctx) {
        switch (depth) {
          case 0:
            [[_config listStyleBulletColor] setFill];
            CGContextFillEllipseInRect(ctx, rect);
            break;
          case 1: {
            CGFloat lineWidth = MAX(1.0, size * 0.15);
            [[_config listStyleBulletColor] setStroke];
            CGContextSetLineWidth(ctx, lineWidth);
            CGContextStrokeEllipseInRect(ctx, CGRectInset(rect, lineWidth / 2.0, lineWidth / 2.0));
            break;
          }
          default:
            [[_config listStyleBulletColor] setFill];
            CGContextFillRect(ctx, rect);
            break;
        }
      }
                 atX:x
                   y:y];
}

- (void)drawOrderedMarkerAtX:(CGFloat)boundaryX number:(NSInteger)number baselineY:(CGFloat)baselineY isRTL:(BOOL)isRTL
{
  NSString *text =
      isRTL ? [NSString stringWithFormat:@".%ld", (long)number] : [NSString stringWithFormat:@"%ld.", (long)number];
  UIFont *font = [_config listMarkerFont] ?: [self defaultFont];

  NSDictionary *mAttrs = @{NSFontAttributeName : font, NSForegroundColorAttributeName : [_config listStyleMarkerColor]};
  CGSize size = [text sizeWithAttributes:mAttrs];
  CGFloat drawX = isRTL ? boundaryX : boundaryX - size.width;

  if ([self isValidX:drawX y:baselineY]) {
    [text drawAtPoint:CGPointMake(drawX, baselineY - font.ascender) withAttributes:mAttrs];
  }
}

- (void)executeDrawing:(void (^)(CGContextRef))block atX:(CGFloat)x y:(CGFloat)y
{
  CGContextRef ctx = UIGraphicsGetCurrentContext();
  if (ctx && [self isValidX:x y:y]) {
    CGContextSaveGState(ctx);
    block(ctx);
    CGContextRestoreGState(ctx);
  }
}

- (UIFont *)defaultFont
{
  return [UIFont systemFontOfSize:[_config listStyleFontSize]];
}

- (BOOL)isValidX:(CGFloat)x y:(CGFloat)y
{
  return !isnan(x) && !isinf(x) && !isnan(y) && !isinf(y);
}

@end
