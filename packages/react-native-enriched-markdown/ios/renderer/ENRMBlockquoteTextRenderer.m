#import "ENRMBlockquoteTextRenderer.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "StyleConfig.h"

@implementation ENRMBlockquoteTextRenderer {
  StyleConfig *_config;
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  self = [super init];
  if (self) {
    _config = config;
  }
  return self;
}

- (void)pushOnContext:(RenderContext *)context
{
  // Only set the blockquote baseline block style (tight paragraphs + the quote's font/color).
  // Unlike the commonmark inline path we do NOT bump blockquoteDepth: the ENRMBlockquoteContainerView
  // already insets its content by the quote's border/gap/padding, so bumping it here would make
  // ListItemRenderer add a second blockquoteIndentForDepth on top and over-indent nested lists.
  [context setBlockStyle:BlockTypeBlockquote font:_config.blockquoteFont color:_config.blockquoteColor headingLevel:0];
}

- (void)postProcess:(NSMutableAttributedString *)text
{
  // Stamp the quote's line height per paragraph. applyLineHeight copies the paragraph style at the
  // range start over the whole range, so applying it across the entire run would overwrite every
  // paragraph with the first one's style - wiping each list item's firstLineHeadIndent/headIndent
  // (the marker draws from a separate attribute, so it would then land on top of un-indented text).
  CGFloat lineHeight = [_config blockquoteLineHeight];
  if (text.length == 0 || lineHeight <= 0) {
    return;
  }
  NSString *string = text.string;
  NSUInteger location = 0;
  while (location < text.length) {
    NSRange paragraph = [string paragraphRangeForRange:NSMakeRange(location, 0)];
    applyLineHeight(text, paragraph, lineHeight);
    applyBaselineOffset(text, paragraph);
    location = NSMaxRange(paragraph);
  }
}

@end
