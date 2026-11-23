#import "ThematicBreakAttachment.h"

@implementation ThematicBreakAttachment

- (CGRect)attachmentBoundsForTextContainer:(NSTextContainer *)textContainer
                      proposedLineFragment:(CGRect)lineFrag
                             glyphPosition:(CGPoint)position
                            characterIndex:(NSUInteger)charIndex
{
  CGFloat totalHeight = self.marginTop + self.lineHeight + self.marginBottom;
  return CGRectMake(0, 0, CGRectGetWidth(lineFrag), totalHeight);
}

- (RCTUIImage *)imageForBounds:(CGRect)imageBounds
                 textContainer:(NSTextContainer *)textContainer
                characterIndex:(NSUInteger)charIndex
{
  RCTUIGraphicsImageRenderer *renderer = [[RCTUIGraphicsImageRenderer alloc] initWithSize:imageBounds.size];

  return [renderer imageWithActions:^(RCTUIGraphicsImageRendererContext *_Nonnull rendererContext) {
    CGContextRef ctx = rendererContext.CGContext;

    CGFloat lineY = self.marginTop + (self.lineHeight / 2.0);

    [self.lineColor setStroke];
    CGContextSetLineWidth(ctx, self.lineHeight);
    CGContextMoveToPoint(ctx, 0, lineY);
    CGContextAddLineToPoint(ctx, imageBounds.size.width, lineY);
    CGContextStrokePath(ctx);
  }];
}

@end
