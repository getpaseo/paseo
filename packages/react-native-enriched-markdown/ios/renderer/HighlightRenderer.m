#import "HighlightRenderer.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

NSString *const HighlightAttributeName = @"EnrichedMarkdownHighlight";

@implementation HighlightRenderer

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

  BlockStyle *blockStyle = [context getBlockStyle];
  RCTUIColor *foregroundColor = [RenderContext calculateHighlightColor:[_config highlightColor]
                                                        paragraphColor:[_config paragraphColor]
                                                            blockColor:blockStyle.color];
  [output addAttribute:NSForegroundColorAttributeName value:foregroundColor range:range];
  [output addAttribute:NSBackgroundColorAttributeName value:[_config highlightBackgroundColor] range:range];
  [output addAttribute:HighlightAttributeName value:@YES range:range];
}

@end
