#import "ENRMSegmentHeightMeasurer.h"
#import "ENRMBlockquoteContainerView.h"
#import "ENRMCodeBlockContainerView.h"
#import "ENRMFeatureFlags.h"
#import "ENRMTextRenderer.h"
#import "ENRMViewFreeMeasurement.h"
#import "TableContainerView.h"
#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathContainerView.h"
#endif
#if ENRICHED_MARKDOWN_VIDEO
#import "ENRMVideoContainerView.h"
#endif

CGFloat ENRMMeasureSegmentsHeightViewFree(NSArray<ENRMRenderedSegment *> *segments, StyleConfig *config,
                                          CGFloat contentWidth, BOOL allowTrailingMargin, CGFloat pointScaleFactor,
                                          ENRMWritingDirectionMode writingDirectionMode,
                                          NSWritingDirection resolvedLayoutDirection, BOOL allowFontScaling,
                                          NSLineBreakStrategy lineBreakStrategy)
{
  if (segments.count == 0) {
    return 0;
  }

  CGFloat totalHeight = 0;
  const NSUInteger lastIndex = segments.count - 1;

  for (NSUInteger i = 0; i < segments.count; i++) {
    ENRMRenderedSegment *segment = segments[i];
    const BOOL isLast = (i == lastIndex);
    const BOOL shouldAddBottomMargin = (!isLast || allowTrailingMargin);

    if (segment.kind == ENRMSegmentKindText && segment.textResult) {
      // GFM segments are never line-clamped (numberOfLines is a no-op for GFM).
      CGSize textSize = ENRMMeasureAttributedTextViewFree(
          segment.textResult.attributedText, contentWidth, config, shouldAddBottomMargin,
          segment.textResult.lastElementMarginBottom, pointScaleFactor, 0, NSLineBreakByWordWrapping, YES);
      totalHeight += textSize.height;
    } else if (segment.kind == ENRMSegmentKindTable && segment.tableSegment) {
      totalHeight += config.tableMarginTop;
      totalHeight += [TableContainerView measureHeightForTableNode:segment.tableSegment.tableNode
                                                            config:config
                                                  allowFontScaling:allowFontScaling
                                             maxFontSizeMultiplier:config.maxFontSizeMultiplier
                                              writingDirectionMode:writingDirectionMode
                                           resolvedLayoutDirection:resolvedLayoutDirection];
      if (shouldAddBottomMargin) {
        totalHeight += config.tableMarginBottom;
      }
    } else if (segment.kind == ENRMSegmentKindCodeBlock && segment.codeBlockSegment) {
      totalHeight += config.codeBlockMarginTop;
      totalHeight += [ENRMCodeBlockContainerView measureHeightForCodeBlockNode:segment.codeBlockSegment.codeBlockNode
                                                                        config:config];
      if (shouldAddBottomMargin) {
        totalHeight += config.codeBlockMarginBottom;
      }
    } else if (segment.kind == ENRMSegmentKindBlockquote && segment.blockquoteSegment) {
      // This helper only ever sums a quote's own children, so any quote here is
      // nested and carries no vertical margin (only the outermost quote does,
      // added by the root measurement pass); mirrors ENRMBlockquoteContainerView.nested.
      totalHeight +=
          [ENRMBlockquoteContainerView measureHeightForBlockquoteNode:segment.blockquoteSegment.blockquoteNode
                                                               config:config
                                                             maxWidth:contentWidth
                                                     pointScaleFactor:pointScaleFactor
                                                     allowFontScaling:allowFontScaling
                                                    lineBreakStrategy:lineBreakStrategy];
    }
#if ENRICHED_MARKDOWN_MATH
    else if (segment.kind == ENRMSegmentKindMath && segment.mathSegment) {
      totalHeight += config.mathMarginTop;
      totalHeight += [ENRMMathContainerView measureHeightForLatex:segment.mathSegment.latex
                                                           config:config
                                                         maxWidth:contentWidth];
      if (shouldAddBottomMargin) {
        totalHeight += config.mathMarginBottom;
      }
    }
#endif
#if ENRICHED_MARKDOWN_VIDEO
    else if (segment.kind == ENRMSegmentKindVideo && segment.videoSegment) {
      totalHeight += config.videoMarginTop;
      totalHeight += [ENRMVideoContainerView measureHeightForVideoNode:segment.videoSegment.videoNode
                                                                config:config
                                                              maxWidth:contentWidth];
      if (shouldAddBottomMargin) {
        totalHeight += config.videoMarginBottom;
      }
    }
#endif
  }

  return totalHeight;
}
