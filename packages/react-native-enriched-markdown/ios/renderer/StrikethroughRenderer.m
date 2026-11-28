#import "StrikethroughRenderer.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

@implementation StrikethroughRenderer

#pragma mark - Rendering

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  NSUInteger start = output.length;
  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  NSRange range = NSMakeRange(start, output.length - start);
  if (range.length == 0)
    return;

  // Apply strikethrough style
  [output addAttribute:NSStrikethroughStyleAttributeName value:@(NSUnderlineStyleSingle) range:range];

  // Apply strikethrough line color (not text color)
  RCTUIColor *strikethroughColor = [_config strikethroughColor];
  [output addAttribute:NSStrikethroughColorAttributeName value:strikethroughColor range:range];
}

@end
