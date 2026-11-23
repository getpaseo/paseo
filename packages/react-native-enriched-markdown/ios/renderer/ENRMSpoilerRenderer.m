#import "ENRMSpoilerRenderer.h"
#import "ENRMSpoilerTapUtils.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"

@implementation ENRMSpoilerRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  NSUInteger start = output.length;
  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  NSRange range = NSMakeRange(start, output.length - start);
  if (range.length == 0)
    return;

  [output addAttribute:SpoilerAttributeName value:@YES range:range];

  [output enumerateAttribute:NSForegroundColorAttributeName
                     inRange:range
                     options:0
                  usingBlock:^(id value, NSRange subRange, BOOL *stop) {
                    if (value) {
                      [output addAttribute:SpoilerOriginalColorAttributeName value:value range:subRange];
                    }
                  }];

  [output addAttribute:NSForegroundColorAttributeName value:[RCTUIColor colorWithWhite:0 alpha:0] range:range];
}

@end
