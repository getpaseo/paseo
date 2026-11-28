#import "ENRMMathInlineRenderer.h"
#import "ENRMMathInlineAttachment.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

#import "ENRMFeatureFlags.h"

#if ENRICHED_MARKDOWN_MATH

@implementation ENRMMathInlineRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  NSString *latex = [self extractLatexFromNode:node];
  if (latex.length == 0) {
    return;
  }

  NSDictionary *textAttrs = [context getTextAttributes];
  UIFont *currentFont = textAttrs[NSFontAttributeName];

  ENRMMathInlineAttachment *attachment = [[ENRMMathInlineAttachment alloc] init];
  attachment.latex = latex;
  attachment.fontSize = currentFont ? currentFont.pointSize : [_config paragraphFontSize];
  attachment.mathTextColor = [_config inlineMathColor];
  [context.mathReporters addObject:attachment];

#if TARGET_OS_OSX
  // On macOS, NSLayoutManager uses self.image/self.bounds rather than calling
  // imageForBounds:textContainer:characterIndex:, so we pre-render eagerly.
  [attachment renderForMacOS];
#endif

  NSMutableAttributedString *attachmentString =
      [[NSAttributedString attributedStringWithAttachment:attachment] mutableCopy];
  if (currentFont) {
    [attachmentString addAttribute:NSFontAttributeName value:currentFont range:NSMakeRange(0, attachmentString.length)];
  }
  [output appendAttributedString:attachmentString];
}

- (NSString *)extractLatexFromNode:(MarkdownASTNode *)node
{
  if (node.content.length > 0) {
    return node.content;
  }

  NSMutableString *buffer = [NSMutableString string];
  for (MarkdownASTNode *child in node.children) {
    if (child.content.length > 0) {
      [buffer appendString:child.content];
    } else if (child.type == MarkdownNodeTypeSoftBreak || child.type == MarkdownNodeTypeLineBreak) {
      [buffer appendString:@" "];
    }
  }
  return buffer;
}

@end

#endif
