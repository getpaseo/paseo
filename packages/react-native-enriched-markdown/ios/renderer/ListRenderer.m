#import "ListRenderer.h"
#import "BlockquoteRenderer.h"
#import "MarkdownASTNode.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

// Inserts the configured vertical gap between consecutive list items (including
// nested ones) by raising paragraphSpacing on the paragraph preceding each item
// start. The first item of the root list gets no spacing above it.
static void applyListItemSpacing(NSMutableAttributedString *output, RenderContext *context, NSUInteger listStart,
                                 CGFloat itemSpacing)
{
  if (itemSpacing <= 0)
    return;

  NSMutableIndexSet *itemStarts = [NSMutableIndexSet indexSet];
  for (NSValue *value in context.listItemRanges) {
    NSUInteger location = [value rangeValue].location;
    if (location >= listStart && location < output.length) {
      [itemStarts addIndex:location];
    }
  }
  if (itemStarts.count < 2)
    return;

  NSString *string = output.string;
  const NSUInteger firstStart = itemStarts.firstIndex;
  [itemStarts enumerateIndexesUsingBlock:^(NSUInteger itemStart, BOOL *stop) {
    if (itemStart == firstStart)
      return;
    NSRange prevParagraph = [string paragraphRangeForRange:NSMakeRange(itemStart - 1, 0)];
    [output enumerateAttribute:NSParagraphStyleAttributeName
                       inRange:prevParagraph
                       options:0
                    usingBlock:^(NSParagraphStyle *style, NSRange range, BOOL *innerStop) {
                      if (style.paragraphSpacing >= itemSpacing)
                        return;
                      NSMutableParagraphStyle *updated =
                          style ? [style mutableCopy] : [[NSMutableParagraphStyle alloc] init];
                      updated.paragraphSpacing = itemSpacing;
                      [output addAttribute:NSParagraphStyleAttributeName value:updated range:range];
                    }];
  }];
}

@implementation ListRenderer {
  BOOL _isOrdered;
}

- (instancetype)initWithRendererFactory:(RendererFactory *)factory config:(StyleConfig *)config isOrdered:(BOOL)ordered
{
  if (self = [super initWithRendererFactory:factory config:config]) {
    _isOrdered = ordered;
  }
  return self;
}

- (id)takeContextSnapshot:(RenderContext *)context
{
  return [context snapshotScope];
}

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  if (!context)
    return;

  const NSInteger prevDepth = context.listDepth;
  const NSUInteger startLocation = output.length;

  if (prevDepth == 0) {
    // Apply top margin for root-level list
    applyBlockSpacingBefore(output, startLocation, _config.listStyleMarginTop);
  } else if (output.length > 0 && ![output.string hasSuffix:@"\n"]) {
    // Ensure nested lists start on a new line
    [output appendAttributedString:kNewlineAttributedString];
  }

  context.listDepth = prevDepth + 1;
  context.listType = _isOrdered ? ListTypeOrdered : ListTypeUnordered;
  NSInteger startNumber = 1;
  NSString *startAttr = node.attributes[@"start"];
  if (_isOrdered && startAttr != nil) {
    startNumber = MAX((NSInteger)0, (NSInteger)startAttr.integerValue);
  }
  // ListItemRenderer pre-increments, so the counter starts one below the
  // first rendered number.
  context.listItemNumber = startNumber - 1;

  [context setBlockStyle:_isOrdered ? BlockTypeOrderedList : BlockTypeUnorderedList
                    font:_config.listStyleFont
                   color:_config.listStyleColor
            headingLevel:0];

  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  if (prevDepth == 0) {
    applyListItemSpacing(output, context, startLocation, [_config listStyleItemSpacing]);
    // Apply bottom margin for root-level list
    applyBlockSpacingAfter(output, _config.listStyleMarginBottom);
  }
}

@end
