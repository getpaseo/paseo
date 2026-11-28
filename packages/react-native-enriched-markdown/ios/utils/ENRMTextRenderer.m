#import "ENRMTextRenderer.h"
#import "AccessibilityInfo.h"
#import "AttributedRenderer.h"
#import "ENRMBlockquoteTextRenderer.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "StyleConfig.h"

@implementation ENRMRenderResult
@end

static ENRMRenderResult *ENRMRenderASTNodesCore(NSArray<MarkdownASTNode *> *nodes, StyleConfig *config,
                                                BOOL allowTrailingMargin, BOOL allowFontScaling,
                                                CGFloat maxFontSizeMultiplier, NSLineBreakStrategy lineBreakStrategy,
                                                ENRMBlockquoteTextRenderer *block)
{
  AttributedRenderer *renderer = [[AttributedRenderer alloc] initWithConfig:config];
  [renderer setAllowTrailingMargin:allowTrailingMargin];

  RenderContext *context = [RenderContext new];
  context.allowFontScaling = allowFontScaling;
  context.maxFontSizeMultiplier = maxFontSizeMultiplier;

  NSMutableAttributedString *attributedText = [renderer renderNodes:nodes context:context block:block];

  [context applyLinkAttributesToString:attributedText];
  [context applyImageAttributesToString:attributedText];
  ENRMApplyLineBreakStrategyToParagraphStyles(attributedText, lineBreakStrategy);
  ENRMPinLineMetricsToStyledFonts(attributedText, NSMakeRange(0, attributedText.length));

  ENRMRenderResult *result = [[ENRMRenderResult alloc] init];
  result.attributedText = attributedText;
  result.context = context;
  result.accessibilityInfo = [AccessibilityInfo infoFromContext:context];
  result.lastElementMarginBottom = [renderer getLastElementMarginBottom];
  return result;
}

ENRMRenderResult *ENRMRenderASTNodes(NSArray<MarkdownASTNode *> *nodes, StyleConfig *config, BOOL allowTrailingMargin,
                                     BOOL allowFontScaling, CGFloat maxFontSizeMultiplier,
                                     NSLineBreakStrategy lineBreakStrategy)
{
  return ENRMRenderASTNodesCore(nodes, config, allowTrailingMargin, allowFontScaling, maxFontSizeMultiplier,
                                lineBreakStrategy, /*block*/ nil);
}

ENRMRenderResult *ENRMRenderBlockquoteContentNodes(NSArray<MarkdownASTNode *> *nodes, StyleConfig *config,
                                                   BOOL allowFontScaling, CGFloat maxFontSizeMultiplier,
                                                   NSLineBreakStrategy lineBreakStrategy)
{
  ENRMBlockquoteTextRenderer *block = [[ENRMBlockquoteTextRenderer alloc] initWithConfig:config];
  return ENRMRenderASTNodesCore(nodes, config, /*allowTrailingMargin*/ NO, allowFontScaling, maxFontSizeMultiplier,
                                lineBreakStrategy, block);
}
