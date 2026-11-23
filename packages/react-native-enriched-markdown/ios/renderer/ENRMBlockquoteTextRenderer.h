#pragma once
#import <Foundation/Foundation.h>

@class RenderContext;
@class StyleConfig;

NS_ASSUME_NONNULL_BEGIN

/**
 * Renders a GFM blockquote's own prose content - the nodes left after nested quotes, code blocks and
 * other block segments have been split out - as blockquote text.
 *
 * It decorates a generic AttributedRenderer pass rather than owning the render envelope itself:
 * -pushOnContext: enters the blockquote baseline block style (+depth) so text picks up the quote's
 * font/color and paragraphs render tight (currentBlockType == Blockquote), matching the commonmark
 * path; -postProcess: applies the quote's line height once the string is complete. It draws no
 * border/background/padding - the ENRMBlockquoteContainerView draws the box.
 */
@interface ENRMBlockquoteTextRenderer : NSObject
- (instancetype)initWithConfig:(StyleConfig *)config;
- (void)pushOnContext:(RenderContext *)context;
- (void)postProcess:(NSMutableAttributedString *)text;
@end

NS_ASSUME_NONNULL_END
