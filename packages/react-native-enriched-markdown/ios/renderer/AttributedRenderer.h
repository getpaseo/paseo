#import <Foundation/Foundation.h>

@class ENRMBlockquoteTextRenderer;
@class MarkdownASTNode;
@class RenderContext;

NS_ASSUME_NONNULL_BEGIN

@interface AttributedRenderer : NSObject
- (instancetype)initWithConfig:(id)config;
// Renders a flat list of sibling nodes into an attributed string: sets the baseline block style,
// walks each node, and trims the trailing block margin. Pass a non-nil block to render the nodes as
// a blockquote's own content (blockquote baseline + the quote's line height applied over the run);
// it draws no box - the ENRMBlockquoteContainerView draws the border/background/padding. See
// ENRMBlockquoteTextRenderer.
- (NSMutableAttributedString *)renderNodes:(NSArray<MarkdownASTNode *> *)nodes
                                   context:(RenderContext *)context
                                     block:(nullable ENRMBlockquoteTextRenderer *)block;
- (CGFloat)getLastElementMarginBottom;
- (void)setAllowTrailingMargin:(BOOL)allow;
@end

NS_ASSUME_NONNULL_END
