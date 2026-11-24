#import "CodeBlockRenderer.h"
#import "CodeBlockBackground.h"
#import "ENRMCodeBlockContent.h"
#import "ENRMCodeBlockHighlighter.h"
#import "LastElementUtils.h"
#import "MarkdownASTNode.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

@implementation CodeBlockRenderer

- (id)takeContextSnapshot:(RenderContext *)context
{
  return [context snapshotScope];
}

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  // In tight lists md4c emits raw Text siblings without paragraph wrappers,
  // so the preceding content may not terminate with a newline.
  if (output.length > 0 && ![output.string hasSuffix:@"\n"]) {
    [output appendAttributedString:kNewlineAttributedString];
  }

  [context setBlockStyle:BlockTypeCodeBlock font:[_config codeBlockFont] color:[_config codeBlockColor] headingLevel:0];

  CGFloat listIndent = context.accumulatedIndent;
  CGFloat padding = [_config codeBlockPadding];
  CGFloat marginTop = [_config codeBlockMarginTop];
  CGFloat marginBottom = [_config codeBlockMarginBottom];

  NSUInteger blockStart = output.length;
  blockStart += applyBlockSpacingBefore(output, blockStart, marginTop);

  // Top Padding: Inserted as a spacer character inside the background area
  // apply only when positive
  if (padding > 0) {
    [output appendAttributedString:kNewlineAttributedString];
    NSMutableParagraphStyle *topSpacerStyle = [context spacerStyleWithHeight:padding spacing:0];
    topSpacerStyle.baseWritingDirection = NSWritingDirectionLeftToRight;
    [output addAttribute:NSParagraphStyleAttributeName value:topSpacerStyle range:NSMakeRange(blockStart, 1)];
  }

  NSUInteger contentStart = output.length;
  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  NSUInteger contentEnd = output.length;
  if (contentEnd <= contentStart)
    return;

  NSRange contentRange = NSMakeRange(contentStart, contentEnd - contentStart);

  ENRMApplyCodeBlockTextAttributes(output, contentRange, _config);

  ENRMApplyHighlightTokens(output, contentRange, ENRMCodeBlockExtractCode(node), ENRMCodeBlockLanguage(node), _config);

  // Horizontal padding is paragraph indentation in this flavor; the shared
  // helper already forced the LTR left-aligned base style.
  NSMutableParagraphStyle *baseStyle = [getOrCreateParagraphStyle(output, contentStart) mutableCopy];
  baseStyle.firstLineHeadIndent = padding + listIndent;
  baseStyle.headIndent = padding + listIndent;
  baseStyle.tailIndent = -padding;
  [output addAttribute:NSParagraphStyleAttributeName value:baseStyle range:contentRange];

  // Bottom Padding: Inserted as a spacer character inside the background area
  // apply it only when positive
  if (padding > 0) {
    NSUInteger bottomPaddingStart = output.length;
    [output appendAttributedString:kNewlineAttributedString];
    NSMutableParagraphStyle *bottomPaddingStyle = [context spacerStyleWithHeight:padding spacing:0];
    bottomPaddingStyle.baseWritingDirection = NSWritingDirectionLeftToRight;
    [output addAttribute:NSParagraphStyleAttributeName
                   value:bottomPaddingStyle
                   range:NSMakeRange(bottomPaddingStart, 1)];
  }

  // Define the range for background rendering (includes padding, excludes margins)
  NSRange backgroundRange = NSMakeRange(blockStart, output.length - blockStart);
  [output addAttribute:CodeBlockAttributeName value:@YES range:backgroundRange];
  if (listIndent > 0) {
    [output addAttribute:CodeBlockIndentAttributeName value:@(listIndent) range:backgroundRange];
  }

  // Recovered by a tap for onCodeBlockPress (the AST node is gone after render).
  NSString *codeBlockText = ENRMCodeBlockExtractCode(node) ?: @"";
  [output addAttribute:@"codeBlockText" value:codeBlockText range:backgroundRange];
  NSString *codeBlockLanguage = ENRMCodeBlockLanguage(node);
  if (codeBlockLanguage) {
    [output addAttribute:@"codeBlockLanguage" value:codeBlockLanguage range:backgroundRange];
  }

  // External Margin: Applied outside the background range
  if (marginBottom > 0) {
    applyBlockSpacingAfter(output, marginBottom);
  }
}

@end
