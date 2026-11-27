#import "ENRMMathInlineAttachmentShared.h"

#if ENRICHED_MARKDOWN_MATH && TARGET_OS_OSX

#if __has_include("ReactNativeEnrichedMarkdown-Swift.h")
#import "ReactNativeEnrichedMarkdown-Swift.h"
#elif __has_include(<ReactNativeEnrichedMarkdown/ReactNativeEnrichedMarkdown-Swift.h>)
#import <ReactNativeEnrichedMarkdown/ReactNativeEnrichedMarkdown-Swift.h>
#endif

@implementation ENRMMathInlineAttachment (macOS)

- (instancetype)init
{
  self = [super init];
  if (self) {
    // NSTextAttachment creates a default NSTextAttachmentCell on macOS.
    // Clear it so NSLayoutManager falls back to the image/bounds properties
    // we set in renderForMacOS.
    self.attachmentCell = nil;
  }
  return self;
}

- (void)renderForMacOS
{
  RCTUIColor *color = self.mathTextColor ?: [RCTUIColor blackColor];
  ENRMRaTeXRenderResult *result = [ENRMRaTeXBridge parse:self.latex displayMode:NO fontSize:self.fontSize color:color];
  if (!result)
    return;

  _renderResult = result;
  _mathAscent = result.ascent;
  _mathDescent = result.descent;
  _cachedSize = CGSizeMake(ceil(result.width), ceil(result.totalHeight));

  // Render the formula into an NSImage. NSLayoutManager draws self.image
  // automatically when attachmentCell is nil, so this is the reliable
  // macOS rendering path instead of imageForBounds:textContainer:characterIndex:.
  //
  // NSImage.lockFocus creates a bottom-left origin Quartz context, but RaTeX
  // expects a UIKit-style top-left origin (Y increases downward). Flip the CTM
  // so the formula renders right-side up.
  NSImage *image = [[NSImage alloc] initWithSize:_cachedSize];
  [image lockFocus];
  CGContextRef ctx = [[NSGraphicsContext currentContext] CGContext];
  CGContextSaveGState(ctx);
  CGContextTranslateCTM(ctx, 0, _cachedSize.height);
  CGContextScaleCTM(ctx, 1.0, -1.0);
  [_renderResult drawIn:ctx];
  CGContextRestoreGState(ctx);
  [image unlockFocus];

  self.image = image;
  self.bounds = CGRectMake(0, -_mathDescent, _cachedSize.width, _cachedSize.height);
}

@end

#endif
