#import "HeadingRenderer.h"
#import "ENRMLinkPillText.h"
#import "FontUtils.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "RuntimeKeys.h"
#import "StyleConfig.h"

// Lightweight struct to hold style data without object overhead
typedef struct {
  __unsafe_unretained UIFont *font;
  __unsafe_unretained RCTUIColor *color;
  CGFloat marginTop;
  CGFloat marginBottom;
  CGFloat lineHeight;
  NSTextAlignment textAlign;
} HeadingStyle;

static NSString *const kHeadingTypes[] = {nil,          @"heading-1", @"heading-2", @"heading-3",
                                          @"heading-4", @"heading-5", @"heading-6"};

@implementation HeadingRenderer

- (id)takeContextSnapshot:(RenderContext *)context
{
  return [context snapshotScope];
}

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  if (output.length > 0 && ![output.string hasSuffix:@"\n"]) {
    [output appendAttributedString:kNewlineAttributedString];
  }

  NSInteger level = [node.attributes[@"level"] integerValue];
  if (level < 1 || level > 6)
    level = 1;

  HeadingStyle style = [self styleForLevel:level];
  [context setBlockStyle:BlockTypeHeading font:style.font color:style.color headingLevel:level];

  NSUInteger start = output.length;
  NSUInteger contentStart = start;

  // Spacing at the very start of the document requires a spacer character (index 0 check)
  if (start == 0) {
    NSUInteger offset = applyBlockSpacingBefore(output, 0, style.marginTop);
    contentStart += offset;
    start += offset;
  }

  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  NSRange range = NSMakeRange(start, output.length - start);
  if (range.length == 0)
    return;

  // Register heading for accessibility
  NSString *headingText = ENRMStringByExpandingLinkPills([output attributedSubstringFromRange:range]);
  [context registerHeadingRange:range level:level text:headingText];

  // Metadata attribute used for post-processing (e.g., Export to Markdown/HTML)
  [output addAttribute:MarkdownTypeAttributeName value:kHeadingTypes[level] range:range];

  applyLineHeight(output, range, style.lineHeight);
  applyBaselineOffset(output, range);
  applyTextAlignment(output, range, style.textAlign);

  // Skip marginTop for the first block — already handled by applyBlockSpacingBefore above
  if (contentStart != 1) {
    NSUInteger inserted = applyParagraphSpacingBefore(output, range, style.marginTop);
    start += inserted;
  }
  applyParagraphSpacingAfter(output, start, style.marginBottom);
}

#pragma mark - Style Mapping

- (HeadingStyle)styleForLevel:(NSInteger)level
{
  StyleConfig *c = _config;
  switch (level) {
    case 1:
      return (HeadingStyle){c.h1Font, c.h1Color, c.h1MarginTop, c.h1MarginBottom, c.h1LineHeight, c.h1TextAlign};
    case 2:
      return (HeadingStyle){c.h2Font, c.h2Color, c.h2MarginTop, c.h2MarginBottom, c.h2LineHeight, c.h2TextAlign};
    case 3:
      return (HeadingStyle){c.h3Font, c.h3Color, c.h3MarginTop, c.h3MarginBottom, c.h3LineHeight, c.h3TextAlign};
    case 4:
      return (HeadingStyle){c.h4Font, c.h4Color, c.h4MarginTop, c.h4MarginBottom, c.h4LineHeight, c.h4TextAlign};
    case 5:
      return (HeadingStyle){c.h5Font, c.h5Color, c.h5MarginTop, c.h5MarginBottom, c.h5LineHeight, c.h5TextAlign};
    case 6:
      return (HeadingStyle){c.h6Font, c.h6Color, c.h6MarginTop, c.h6MarginBottom, c.h6LineHeight, c.h6TextAlign};
    default:
      return [self styleForLevel:1];
  }
}

@end