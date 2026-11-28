#import "BlankLineRenderer.h"
#import "MarkdownASTNode.h"
#import "ParagraphStyleUtils.h"
#import "StyleConfig.h"

#pragma mark - Renderer Implementation

// Renders a run of consecutive blank lines emitted by the parser when the
// preserveBlankLines flag is enabled. Each blank line in the source is drawn as
// one empty line, so the rendered text keeps the exact line count that was typed
// (e.g. in EnrichedMarkdownTextInput). The empty lines use the paragraph font
// and line height so their vertical rhythm matches the surrounding paragraphs;
// any extra block spacing is left to the caller to configure via markdownStyle.
@implementation BlankLineRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  NSInteger count = [node.attributes[@"count"] integerValue];
  if (count <= 0) {
    return;
  }

  [self ensureStartingNewline:output];

  NSDictionary *attributes = @{NSFontAttributeName : _config.paragraphFont};

  NSMutableString *blanks = [NSMutableString stringWithCapacity:(NSUInteger)count];
  for (NSInteger i = 0; i < count; i++) {
    [blanks appendString:@"\n"];
  }

  NSUInteger start = output.length;
  [output appendAttributedString:[[NSAttributedString alloc] initWithString:blanks attributes:attributes]];

  NSRange range = NSMakeRange(start, output.length - start);
  applyLineHeight(output, range, _config.paragraphLineHeight);
  applyTextAlignment(output, range, _config.paragraphTextAlign);
}

#pragma mark - Private Utilities

- (void)ensureStartingNewline:(NSMutableAttributedString *)output
{
  if (output.length > 0 && ![output.string hasSuffix:@"\n"]) {
    [output appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
  }
}

@end
