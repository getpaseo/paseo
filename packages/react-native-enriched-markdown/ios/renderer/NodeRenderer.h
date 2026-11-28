#import <Foundation/Foundation.h>

@class MarkdownASTNode;
@class RenderContext;

@protocol NodeRenderer <NSObject>
- (void)renderNode:(MarkdownASTNode *)node into:(NSMutableAttributedString *)output context:(RenderContext *)context;
@end
