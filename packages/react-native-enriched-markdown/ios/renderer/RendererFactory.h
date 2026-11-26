#import "MarkdownASTNode.h"
#import "NodeRenderer.h"

@class RenderContext;

@interface RendererFactory : NSObject
- (instancetype)initWithConfig:(id)config;
- (id<NodeRenderer>)rendererForNodeType:(MarkdownNodeType)type;
- (void)renderChildrenOfNode:(MarkdownASTNode *)node
                        into:(NSMutableAttributedString *)output
                     context:(RenderContext *)context;
@end
