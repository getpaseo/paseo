#import "CodeBlockBackground.h"
#import "ENRMUIKit.h"
#import "LastElementUtils.h"
#import "StyleConfig.h"

// Draws the commonmark-flavor code block box behind the text view's glyph
// runs. The visual conventions (half-stroke border inset, corner radius
// handling) must stay in sync with the whole-rect box the github flavor
// draws in ENRMCodeBlockContainerView's drawRect:.

@implementation CodeBlockBackground {
  StyleConfig *_config;
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  if (self = [super init]) {
    _config = config;
  }
  return self;
}

- (void)drawBackgroundsForGlyphRange:(NSRange)glyphsToShow
                       layoutManager:(NSLayoutManager *)layoutManager
                       textContainer:(NSTextContainer *)textContainer
                             atPoint:(CGPoint)origin
{
  NSTextStorage *textStorage = layoutManager.textStorage;
  NSRange charRange = [layoutManager characterRangeForGlyphRange:glyphsToShow actualGlyphRange:NULL];

  // Enumerate over the full storage range so each code block's full rect is drawn.
  // Restricting to charRange causes partial rects per draw pass, which produces
  // multiple stacked oval shapes when border radius is large.
  // The graphics context clip ensures only the visible portion is painted.
  [textStorage enumerateAttribute:CodeBlockAttributeName
                          inRange:NSMakeRange(0, textStorage.length)
                          options:0
                       usingBlock:^(id value, NSRange range, BOOL *stop) {
                         if (!value)
                           return;
                         if (NSIntersectionRange(range, charRange).length == 0)
                           return;
                         [self drawCodeBlockBackgroundForRange:range
                                                 layoutManager:layoutManager
                                                 textContainer:textContainer
                                                       atPoint:origin];
                       }];
}

- (void)drawCodeBlockBackgroundForRange:(NSRange)range
                          layoutManager:(NSLayoutManager *)layoutManager
                          textContainer:(NSTextContainer *)textContainer
                                atPoint:(CGPoint)origin
{
  NSRange glyphRange = [layoutManager glyphRangeForCharacterRange:range actualCharacterRange:NULL];
  CGRect blockRect = [layoutManager boundingRectForGlyphRange:glyphRange inTextContainer:textContainer];

  if (CGRectIsEmpty(blockRect))
    return;

  NSNumber *indentAttr = [layoutManager.textStorage attribute:CodeBlockIndentAttributeName
                                                      atIndex:range.location
                                               effectiveRange:NULL];
  CGFloat indent = [indentAttr doubleValue];

  CGFloat availableWidth = textContainer.size.width - indent;
  if (availableWidth <= 0)
    return;

  blockRect.origin.x = origin.x + indent;
  blockRect.origin.y += origin.y;
  blockRect.size.width = availableWidth;

  // We extend the background specifically to cover the bottom padding spacer,
  // excluding any additional marginBottom applied via measurement.
  BOOL isLastCodeBlock = (NSMaxRange(range) == layoutManager.textStorage.length);
  if (isLastCodeBlock) {
    blockRect.size.height += [_config codeBlockPadding];
  }

  CGFloat borderWidth = [_config codeBlockBorderWidth];
  CGFloat borderRadius = [_config codeBlockBorderRadius];
  CGFloat inset = borderWidth / 2.0;

  CGRect insetRect = CGRectInset(blockRect, inset, inset);
  UIBezierPath *path = UIBezierPathWithRoundedRect(insetRect, MAX(0, borderRadius - inset));

  CGContextRef ctx = UIGraphicsGetCurrentContext();
  CGContextSaveGState(ctx);
  {
    [[_config codeBlockBackgroundColor] setFill];
    [path fill];

    if (borderWidth > 0) {
      [[_config codeBlockBorderColor] setStroke];
      path.lineWidth = borderWidth;
      BezierPathSetRoundStyle(path);
      [path stroke];
    }
  }
  CGContextRestoreGState(ctx);
}
@end