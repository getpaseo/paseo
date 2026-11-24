#import "SubscriptRenderer.h"
#import "BaselineShiftTextAttributes.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

@implementation SubscriptRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  NSUInteger start = output.length;
  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  NSRange range = NSMakeRange(start, output.length - start);
  if (range.length == 0)
    return;

  [output addAttribute:ENRMScriptAttributeName value:ENRMScriptValueSubscript range:range];
  ENRMApplyBaselineShift(output, range, _config.subscriptFontScale, -_config.subscriptBaselineOffsetScale);
}

@end
