#import "ENRMMathFallback.h"
#import "ENRMMathInlineAttachmentShared.h"

#if ENRICHED_MARKDOWN_MATH

#if __has_include("ReactNativeEnrichedMarkdown-Swift.h")
#import "ReactNativeEnrichedMarkdown-Swift.h"
#elif __has_include(<ReactNativeEnrichedMarkdown/ReactNativeEnrichedMarkdown-Swift.h>)
#import <ReactNativeEnrichedMarkdown/ReactNativeEnrichedMarkdown-Swift.h>
#endif

@implementation ENRMMathInlineAttachment

- (CGFloat)boxHeight
{
#if !TARGET_OS_OSX
  [self prepareIfNeeded];
#endif
  return _cachedSize.height;
}

- (void)reportLatexErrorIfNeeded
{
  if (_parseFailed && !_didReportError && self.onLatexError) {
    _didReportError = YES;
    self.onLatexError(self.latex, _parseMessage ?: @"", self.displayMode);
  }
}

#if !TARGET_OS_OSX

- (void)prepareIfNeeded
{
  if (_renderResult || _fallbackSource)
    return;

  RCTUIColor *color = self.mathTextColor ?: [RCTUIColor blackColor];
  NSError *error = nil;
  ENRMRaTeXRenderResult *result = [ENRMRaTeXBridge parse:self.latex
                                             displayMode:self.displayMode
                                                fontSize:self.fontSize
                                                   color:color
                                                   error:&error];
  if (!result) {
    _parseFailed = YES;
    _parseMessage = error.localizedDescription ?: @"";
    [self reportLatexErrorIfNeeded];
    _fallbackSource = ENRMMathFallbackString(self.latex, @"$", self.fontSize, color);
    UIFont *font = [_fallbackSource attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL];
    CGRect bounds = [_fallbackSource boundingRectWithSize:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)
                                                  options:NSStringDrawingUsesLineFragmentOrigin
                                                  context:nil];
    _mathAscent = font.ascender;
    _mathDescent = -font.descender;
    _cachedSize = CGSizeMake(ceil(bounds.size.width), ceil(_mathAscent + _mathDescent));
    return;
  }

  _renderResult = result;
  _mathAscent = result.ascent;
  _mathDescent = result.descent;
  _cachedSize = CGSizeMake(ceil(result.width), ceil(result.totalHeight));
}

- (CGRect)attachmentBoundsForTextContainer:(NSTextContainer *)textContainer
                      proposedLineFragment:(CGRect)lineFragment
                             glyphPosition:(CGPoint)position
                            characterIndex:(NSUInteger)characterIndex
{
  [self prepareIfNeeded];
  return CGRectMake(0, -_mathDescent, _cachedSize.width, _cachedSize.height);
}

- (UIImage *)imageForBounds:(CGRect)imageBounds
              textContainer:(NSTextContainer *)textContainer
             characterIndex:(NSUInteger)characterIndex
{
  [self prepareIfNeeded];
  if (!_renderResult && !_fallbackSource)
    return nil;

  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
  format.opaque = NO;

  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:_cachedSize format:format];

  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *rendererContext) {
    if (_renderResult) {
      CGContextRef ctx = rendererContext.CGContext;
      CGContextSaveGState(ctx);
      [_renderResult drawIn:ctx];
      CGContextRestoreGState(ctx);
    } else {
      [_fallbackSource drawWithRect:CGRectMake(0, 0, _cachedSize.width, _cachedSize.height)
                            options:NSStringDrawingUsesLineFragmentOrigin
                            context:nil];
    }
  }];
}

#endif

@end

#endif
