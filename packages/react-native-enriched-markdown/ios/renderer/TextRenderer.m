#import "TextRenderer.h"
#import "RenderContext.h"

@implementation TextRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  if (!node.content)
    return;

  NSAttributedString *text = [[NSAttributedString alloc] initWithString:node.content
                                                             attributes:[context getTextAttributes]];
  [output appendAttributedString:text];
}

@end
