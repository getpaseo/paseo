#import "ThematicBreakRenderer.h"
#import "MarkdownASTNode.h"
#import "StyleConfig.h"
#import "ThematicBreakAttachment.h"

#pragma mark - Renderer Implementation

@implementation ThematicBreakRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  [self ensureStartingNewline:output];

  ThematicBreakAttachment *attachment = [[ThematicBreakAttachment alloc] init];
  attachment.lineColor = _config.thematicBreakColor ?: [RCTUIColor separatorColor];
  attachment.lineHeight = _config.thematicBreakHeight > 0 ? _config.thematicBreakHeight : 1.0;
  attachment.marginTop = _config.thematicBreakMarginTop;
  attachment.marginBottom = _config.thematicBreakMarginBottom;

  NSDictionary *attributes = @{
    NSAttachmentAttributeName : attachment,
    NSParagraphStyleAttributeName : [NSParagraphStyle defaultParagraphStyle]
  };

  NSAttributedString *breakString = [[NSAttributedString alloc] initWithString:@"\uFFFC" attributes:attributes];

  [output appendAttributedString:breakString];
  [output appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
}

#pragma mark - Private Utilities

- (void)ensureStartingNewline:(NSMutableAttributedString *)output
{
  if (output.length > 0 && ![output.string hasSuffix:@"\n"]) {
    [output appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
  }
}

@end