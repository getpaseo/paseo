#import "ListItemRenderer.h"
#import "BlockquoteBorder.h"
#import "ENRMUIKit.h"
#import "LastElementUtils.h"
#import "MarkdownASTNode.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

NSString *const ListDepthAttribute = @"ListDepth";
NSString *const ListTypeAttribute = @"ListType";
NSString *const ListItemNumberAttribute = @"ListItemNumber";
NSString *const ListItemMarkerStartAttribute = @"ListItemMarkerStart";
NSString *const TaskItemAttribute = @"TaskItem";
NSString *const TaskCheckedAttribute = @"TaskChecked";
NSString *const TaskIndexAttribute = @"TaskIndex";

@implementation ENRMListMarkerDescriptor
@end

// NSArray's -hash is its count, so plain one-marker arrays all collide in the
// table that uniques attribute dictionaries, and each list item probes past
// every earlier one. Hashing by the item's own marker keeps rendering linear.
@interface ENRMListMarkerArray : NSArray
@end

@implementation ENRMListMarkerArray {
  NSArray<ENRMListMarkerDescriptor *> *_markers;
}

- (instancetype)initWithMarkers:(NSArray<ENRMListMarkerDescriptor *> *)markers
{
  if (self = [super init]) {
    _markers = [markers copy];
  }
  return self;
}

- (NSUInteger)count
{
  return _markers.count;
}

- (id)objectAtIndex:(NSUInteger)index
{
  return _markers[index];
}

- (NSUInteger)hash
{
  return _markers.lastObject.hash;
}

@end

@interface ListItemRenderer ()
- (void)applyCheckedDecorationsTo:(NSMutableAttributedString *)output
                            range:(NSRange)range
                     nestingLevel:(NSInteger)nestingLevel;
@end

@implementation ListItemRenderer

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  if (!context)
    return;

  context.listItemNumber++;
  const NSInteger currentPosition = context.listItemNumber;
  const NSInteger currentDepth = context.listDepth; // 1-based (1 = top level)

  const BOOL isTask = [node.attributes[@"isTask"] isEqualToString:@"true"];
  const BOOL isChecked = isTask && [node.attributes[@"taskChecked"] isEqualToString:@"true"];
  NSInteger taskIndex = -1;
  if (isTask) {
    taskIndex = context.taskItemCount;
    context.taskItemCount++;
  }

  // currentDepth - 1 handles the horizontal offset for nested lists
  const NSInteger nestingLevel = currentDepth - 1;
  const CGFloat baseMarkerWidth = isTask                                  ? [_config effectiveListMarginLeftForTask]
                                  : (context.listType == ListTypeOrdered) ? [_config effectiveListMarginLeftForNumber]
                                                                          : [_config effectiveListMarginLeftForBullet];

  const CGFloat blockquoteIndent =
      blockquoteIndentForDepth(context.blockquoteDepth, [_config blockquoteBorderWidth] + [_config blockquoteGapWidth]);

  const CGFloat totalIndent = blockquoteIndent + baseMarkerWidth + [_config effectiveListGapWidth] +
                              (nestingLevel * [_config listStyleMarginLeft]);

  const NSUInteger startLocation = output.length;

  // Manual save/restore — a scope snapshot would also roll back the listItemNumber increment
  const CGFloat prevIndent = context.accumulatedIndent;
  context.accumulatedIndent = totalIndent;
  @try {
    [_rendererFactory renderChildrenOfNode:node into:output context:context];
  } @finally {
    context.accumulatedIndent = prevIndent;
  }

  // Ensure every list item ends with a newline to prevent paragraph merging
  if (output.length > startLocation && ![output.string hasSuffix:@"\n"]) {
    [output appendAttributedString:kNewlineAttributedString];
  }

  const NSRange itemRange = NSMakeRange(startLocation, output.length - startLocation);
  if (itemRange.length == 0)
    return;

  // Informs MarkdownAccessibilityElementBuilder about the specific boundaries of this list item
  [context registerListItemRange:itemRange
                        position:currentPosition
                           depth:currentDepth
                       isOrdered:(context.listType == ListTypeOrdered)];

  const CGFloat lineHeightConfig = [_config listStyleLineHeight];

  // Boxing metadata for attributed string storage
  NSMutableDictionary *metadata = [@{
    ListDepthAttribute : @(nestingLevel),
    ListTypeAttribute : @(context.listType),
    ListItemNumberAttribute : @(currentPosition)
  } mutableCopy];

  if (isTask) {
    metadata[TaskItemAttribute] = @YES;
    metadata[TaskCheckedAttribute] = @(isChecked);
    metadata[TaskIndexAttribute] = @(taskIndex);
  }

  // Preserve styles of nested sub-lists and code blocks by applying the list
  // paragraph style only to the surviving gaps between them.
  NSMutableArray<NSValue *> *skipRanges = [NSMutableArray array];
  [output enumerateAttribute:CodeBlockAttributeName
                     inRange:itemRange
                     options:0
                  usingBlock:^(id value, NSRange range, BOOL *stop) {
                    if ([value boolValue]) {
                      [skipRanges addObject:[NSValue valueWithRange:range]];
                    }
                  }];
  [output enumerateAttribute:ListDepthAttribute
                     inRange:itemRange
                     options:0
                  usingBlock:^(id depthAttr, NSRange range, BOOL *stop) {
                    if (depthAttr && [depthAttr integerValue] > nestingLevel) {
                      [skipRanges addObject:[NSValue valueWithRange:range]];
                    }
                  }];
  [skipRanges sortUsingComparator:^NSComparisonResult(NSValue *a, NSValue *b) {
    NSUInteger la = [a rangeValue].location;
    NSUInteger lb = [b rangeValue].location;
    return la < lb ? NSOrderedAscending : (la > lb ? NSOrderedDescending : NSOrderedSame);
  }];

  void (^applyStyleToRange)(NSRange) = ^(NSRange range) {
    if (range.length == 0)
      return;
    NSMutableParagraphStyle *style = [[NSMutableParagraphStyle alloc] init];
    style.firstLineHeadIndent = totalIndent;
    style.headIndent = totalIndent;
    const CGFloat lineHeight = ENRMLineHeightWithLinkPills(output, range, lineHeightConfig);
    if (lineHeight > 0) {
      style.minimumLineHeight = lineHeight;
    }
    NSMutableDictionary *attributesToApply = [metadata mutableCopy];
    attributesToApply[NSParagraphStyleAttributeName] = style;
    [output addAttributes:attributesToApply range:range];
    if (lineHeight > 0) {
      applyBaselineOffset(output, range);
    }
  };

  NSUInteger pos = itemRange.location;
  const NSUInteger itemEnd = NSMaxRange(itemRange);
  for (NSValue *val in skipRanges) {
    NSRange skip = [val rangeValue];
    if (pos < skip.location) {
      applyStyleToRange(NSMakeRange(pos, skip.location - pos));
    }
    pos = MAX(pos, NSMaxRange(skip));
  }
  if (pos < itemEnd) {
    applyStyleToRange(NSMakeRange(pos, itemEnd - pos));
  }

  ENRMListMarkerDescriptor *marker = [[ENRMListMarkerDescriptor alloc] init];
  marker.isTask = isTask;
  marker.isChecked = isChecked;
  marker.taskIndex = taskIndex;
  marker.listType = context.listType;
  marker.number = currentPosition;
  marker.depth = nestingLevel;
  marker.indent = totalIndent;

  // Anchor on the first content character so items that open with a code block
  // or nested sublist still get their marker; fall back to startLocation for
  // whitespace-only items.
  NSUInteger anchorLocation = startLocation;
  NSString *string = output.string;
  for (NSUInteger i = startLocation; i < itemEnd; i++) {
    if ([string characterAtIndex:i] != '\n') {
      anchorLocation = i;
      break;
    }
  }

  // Cover the whole grapheme cluster: anchoring on a single UTF-16 code unit
  // splits multi-unit graphemes (emoji surrogate pairs, ZWJ sequences) across
  // two attribute runs, which drops the glyph and hides the marker for every
  // item but the last.
  const NSRange anchorRange = [string rangeOfComposedCharacterSequenceAtIndex:anchorLocation];

  NSArray *existingMarkers = [output attribute:ListItemMarkerStartAttribute atIndex:anchorLocation effectiveRange:NULL];
  NSArray *markers =
      [existingMarkers isKindOfClass:[NSArray class]] ? [existingMarkers arrayByAddingObject:marker] : @[ marker ];
  [output addAttribute:ListItemMarkerStartAttribute
                 value:[[ENRMListMarkerArray alloc] initWithMarkers:markers]
                 range:anchorRange];

  if (isTask && isChecked) {
    [self applyCheckedDecorationsTo:output range:itemRange nestingLevel:nestingLevel];
  }
}

- (void)applyCheckedDecorationsTo:(NSMutableAttributedString *)output
                            range:(NSRange)range
                     nestingLevel:(NSInteger)nestingLevel
{
  RCTUIColor *checkedColor = [_config taskListCheckedTextColor];
  BOOL shouldStrikethrough = [_config taskListCheckedStrikethrough];

  if (!checkedColor && !shouldStrikethrough) {
    return;
  }

  NSMutableDictionary *checkedAttrs = [NSMutableDictionary dictionary];

  if (checkedColor) {
    checkedAttrs[NSForegroundColorAttributeName] = checkedColor;
  }

  if (shouldStrikethrough) {
    checkedAttrs[NSStrikethroughStyleAttributeName] = @(NSUnderlineStyleSingle);

    RCTUIColor *lineColor = checkedColor ?: [_config listStyleColor];
    if (lineColor) {
      checkedAttrs[NSStrikethroughColorAttributeName] = lineColor;
    }
  }

  [output enumerateAttribute:ListDepthAttribute
                     inRange:range
                     options:0
                  usingBlock:^(NSNumber *depth, NSRange segmentRange, BOOL *stop) {
                    BOOL isNestedSubItem = (depth && [depth integerValue] > nestingLevel);
                    if (isNestedSubItem) {
                      return;
                    }

                    // Skip code block ranges — preserve CodeBlockRenderer styles.
                    NSNumber *isCodeBlock = [output attribute:CodeBlockAttributeName
                                                      atIndex:segmentRange.location
                                               effectiveRange:nil];
                    if ([isCodeBlock boolValue]) {
                      return;
                    }

                    [output addAttributes:checkedAttrs range:segmentRange];
                  }];
}

@end
