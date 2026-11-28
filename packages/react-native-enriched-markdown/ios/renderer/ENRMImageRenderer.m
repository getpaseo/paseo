#import "ENRMImageRenderer.h"
#import "ENRMImageAttachment.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

static const unichar kLineBreak = '\n';
static const unichar kZeroWidthSpace = 0x200B;

@implementation ENRMImageRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  NSString *imageURL = node.attributes[@"url"];
  if (!imageURL || imageURL.length == 0) {
    return;
  }

  BOOL isInline = [self isInlineImageInOutput:output];
  ENRMImageAttachment *attachment = [ENRMImageAttachment attachmentForURL:imageURL config:_config isInline:isInline];

  NSUInteger startIndex = output.length;

  NSAttributedString *imageString = [NSAttributedString attributedStringWithAttachment:attachment];
  [output appendAttributedString:imageString];

  // Extract alt text from children (![alt text](url) - "alt text" is in children)
  NSString *altText = [self extractTextFromNode:node];
  NSRange imageRange = NSMakeRange(startIndex, output.length - startIndex);
  [context registerImageRange:imageRange altText:altText url:imageURL];
}

- (NSString *)extractTextFromNode:(MarkdownASTNode *)node
{
  if (!node)
    return @"";

  NSMutableString *buffer = [NSMutableString string];
  [self _appendChildTextFromNode:node toBuffer:buffer];
  return [buffer stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

- (void)_appendChildTextFromNode:(MarkdownASTNode *)node toBuffer:(NSMutableString *)buffer
{
  if (node.content.length > 0) {
    [buffer appendString:node.content];
  } else if (node.type == MarkdownNodeTypeSoftBreak || node.type == MarkdownNodeTypeLineBreak) {
    [buffer appendString:@" "];
  }

  for (MarkdownASTNode *child in node.children) {
    [self _appendChildTextFromNode:child toBuffer:buffer];
  }
}

- (BOOL)isInlineImageInOutput:(NSAttributedString *)output
{
  if (output.length == 0) {
    return NO;
  }

  unichar lastChar = [output.string characterAtIndex:output.length - 1];
  return (lastChar != kLineBreak && lastChar != kZeroWidthSpace);
}

@end