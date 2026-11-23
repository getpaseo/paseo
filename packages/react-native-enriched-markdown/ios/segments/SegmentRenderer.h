#pragma once

#import <Foundation/Foundation.h>

@class ENRMRenderedSegment;
@class MarkdownASTNode;
@class StyleConfig;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

// blockquoteContent = YES when splitting a blockquote's own children (called by
// ENRMBlockquoteContainerView): text segments are then rendered with blockquote styling
// (tight paragraphs, quote font/color/line height) instead of paragraph styling.
NSArray<ENRMRenderedSegment *> *
ENRMRenderSegmentsFromAST(MarkdownASTNode *ast, StyleConfig *config, BOOL allowTrailingMargin, BOOL allowFontScaling,
                          CGFloat maxFontSizeMultiplier, NSLineBreakStrategy lineBreakStrategy, BOOL blockquoteContent);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
