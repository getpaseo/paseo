#import "UnderlineRenderer.h"
#import "ENRMTextLinkAttributes.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

@implementation UnderlineRenderer

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

  [output addAttribute:NSUnderlineStyleAttributeName value:@(NSUnderlineStyleSingle) range:range];
  // Recognized links inside this span were styled before it closed; record the underline for them too.
  [output enumerateAttribute:ENRMRecognizedLinkAttributeName
                     inRange:range
                     options:0
                  usingBlock:^(id value, NSRange linkRange, BOOL *stop) {
                    if ([value boolValue]) {
                      [output addAttribute:ENRMRecognizedLinkOriginalUnderlineAttributeName
                                     value:@(NSUnderlineStyleSingle)
                                     range:linkRange];
                    }
                  }];

  RCTUIColor *underlineColor = [_config underlineColor];

  [output addAttribute:NSUnderlineColorAttributeName value:underlineColor range:range];
}

@end
