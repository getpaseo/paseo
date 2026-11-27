#import "RTFExportUtils.h"
#import "BlockquoteBorder.h"
#import "CodeBackground.h"
#import "ENRMLinkPillText.h"
#import "LastElementUtils.h"
#import "ListItemRenderer.h"
#import "RenderContext.h"
#import "StyleConfig.h"
#import "ThematicBreakAttachment.h"

static const CGFloat kListIndentPerLevel = 12.0;
static const CGFloat kMinParagraphSpacing = 4.0;
static const CGFloat kPaddingLineHeightThreshold = 20.0;
static const CGFloat kNormalizedPaddingHeight = 2.0;

/// Lightweight struct for marker insertion (avoids NSDictionary allocation overhead)
typedef struct {
  NSUInteger position;
  NSInteger depth;
  NSInteger itemNumber;
  BOOL isOrdered;
} MarkerInfo;

#pragma mark - Line Position Utilities

static void collectLineStartsInRange(NSString *string, NSRange range, void (^handler)(NSUInteger lineStart))
{
  NSUInteger pos = range.location;
  NSUInteger end = NSMaxRange(range);

  while (pos < end) {
    handler(pos);
    NSRange lineRange = [string lineRangeForRange:NSMakeRange(pos, 0)];
    pos = NSMaxRange(lineRange);
  }
}

#pragma mark - Inline Code Processing

static void processCodes(NSMutableAttributedString *text, RCTUIColor *bgColor)
{
  if (!bgColor)
    return;

  [text enumerateAttribute:CodeAttributeName
                   inRange:NSMakeRange(0, text.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if (![value boolValue])
                    return;

                  [text addAttribute:NSBackgroundColorAttributeName value:bgColor range:range];
                }];
}

#pragma mark - Code Block Processing

static void processCodeBlocks(NSMutableAttributedString *text, RCTUIColor *bgColor)
{
  if (!bgColor)
    return;

  [text enumerateAttribute:CodeBlockAttributeName
                   inRange:NSMakeRange(0, text.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if (![value boolValue])
                    return;

                  [text addAttribute:NSBackgroundColorAttributeName value:bgColor range:range];

                  // Normalize padding spacers (small fixed line heights used for visual padding)
                  [text enumerateAttribute:NSParagraphStyleAttributeName
                                   inRange:range
                                   options:0
                                usingBlock:^(NSParagraphStyle *style, NSRange paraRange, BOOL *innerStop) {
                                  if (!style)
                                    return;

                                  CGFloat minHeight = style.minimumLineHeight;
                                  CGFloat maxHeight = style.maximumLineHeight;

                                  if (minHeight > 0 && minHeight == maxHeight &&
                                      minHeight < kPaddingLineHeightThreshold) {
                                    NSMutableParagraphStyle *normalStyle = [style mutableCopy];
                                    normalStyle.minimumLineHeight = kNormalizedPaddingHeight;
                                    normalStyle.maximumLineHeight = kNormalizedPaddingHeight;
                                    [text addAttribute:NSParagraphStyleAttributeName value:normalStyle range:paraRange];
                                  }
                                }];
                }];
}

#pragma mark - Blockquote Processing

static void processBlockquotes(NSMutableAttributedString *text, RCTUIColor *bgColor)
{
  NSString *string = text.string;

  // Collect marker positions (using C array for performance)
  NSMutableData *markersData = [NSMutableData data];

  [text enumerateAttribute:BlockquoteDepthAttributeName
                   inRange:NSMakeRange(0, text.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if (!value || [value integerValue] < 0)
                    return;

                  NSInteger depth = [value integerValue];
                  collectLineStartsInRange(string, range, ^(NSUInteger lineStart) {
                    MarkerInfo info = {.position = lineStart, .depth = depth, .itemNumber = 0, .isOrdered = NO};
                    [markersData appendBytes:&info length:sizeof(MarkerInfo)];
                  });
                }];

  // Sort descending (insert from end to avoid index shifting)
  NSUInteger count = markersData.length / sizeof(MarkerInfo);
  MarkerInfo *markers = (MarkerInfo *)markersData.mutableBytes;

  qsort_b(markers, count, sizeof(MarkerInfo), ^int(const void *a, const void *b) {
    NSUInteger posA = ((MarkerInfo *)a)->position;
    NSUInteger posB = ((MarkerInfo *)b)->position;
    return (posB > posA) - (posB < posA);
  });

  // Insert "> " markers from end to start
  for (NSUInteger i = 0; i < count; i++) {
    MarkerInfo info = markers[i];

    NSMutableString *marker = [NSMutableString stringWithCapacity:(info.depth + 1) * 2];
    for (NSInteger d = 0; d <= info.depth; d++) {
      [marker appendString:@"> "];
    }

    NSDictionary *attrs = [text attributesAtIndex:info.position effectiveRange:NULL];
    NSMutableDictionary *markerAttrs = bgColor ? [attrs mutableCopy] : attrs;
    if (bgColor) {
      markerAttrs[NSBackgroundColorAttributeName] = bgColor;
    }

    NSAttributedString *markerString = [[NSAttributedString alloc] initWithString:marker attributes:markerAttrs];
    [text insertAttributedString:markerString atIndex:info.position];
  }

  // Normalize styles (background, spacing, remove indentation since markers provide visual indication)
  [text enumerateAttribute:BlockquoteDepthAttributeName
                   inRange:NSMakeRange(0, text.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if (!value || [value integerValue] < 0)
                    return;

                  if (bgColor) {
                    [text addAttribute:NSBackgroundColorAttributeName value:bgColor range:range];
                  }

                  [text enumerateAttribute:NSParagraphStyleAttributeName
                                   inRange:range
                                   options:0
                                usingBlock:^(NSParagraphStyle *style, NSRange paraRange, BOOL *innerStop) {
                                  if (!style)
                                    return;

                                  NSMutableParagraphStyle *normalStyle = [style mutableCopy];
                                  if (normalStyle.paragraphSpacing > kMinParagraphSpacing) {
                                    normalStyle.paragraphSpacing = kMinParagraphSpacing;
                                  }
                                  normalStyle.paragraphSpacingBefore = 0;
                                  normalStyle.firstLineHeadIndent = 0;
                                  normalStyle.headIndent = 0;

                                  [text addAttribute:NSParagraphStyleAttributeName value:normalStyle range:paraRange];
                                }];
                }];
}

#pragma mark - List Processing

static void processLists(NSMutableAttributedString *text)
{
  NSString *string = text.string;

  // Collect list item positions
  NSMutableData *markersData = [NSMutableData data];

  [text enumerateAttribute:ListDepthAttribute
                   inRange:NSMakeRange(0, text.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if (!value || [value integerValue] < 0)
                    return;

                  collectLineStartsInRange(string, range, ^(NSUInteger lineStart) {
                    NSDictionary *attrs = [text attributesAtIndex:lineStart effectiveRange:NULL];
                    NSNumber *depthNum = attrs[ListDepthAttribute];
                    NSNumber *listType = attrs[ListTypeAttribute];
                    NSNumber *itemNumber = attrs[ListItemNumberAttribute];

                    if (depthNum && [depthNum integerValue] >= 0) {
                      MarkerInfo info = {.position = lineStart,
                                         .depth = [depthNum integerValue],
                                         .itemNumber = itemNumber ? [itemNumber integerValue] : 1,
                                         .isOrdered = listType && [listType integerValue] == ListTypeOrdered};
                      [markersData appendBytes:&info length:sizeof(MarkerInfo)];
                    }
                  });
                }];

  // Sort descending
  NSUInteger count = markersData.length / sizeof(MarkerInfo);
  MarkerInfo *markers = (MarkerInfo *)markersData.mutableBytes;

  qsort_b(markers, count, sizeof(MarkerInfo), ^int(const void *a, const void *b) {
    NSUInteger posA = ((MarkerInfo *)a)->position;
    NSUInteger posB = ((MarkerInfo *)b)->position;
    return (posB > posA) - (posB < posA);
  });

  // Insert markers
  for (NSUInteger i = 0; i < count; i++) {
    MarkerInfo info = markers[i];
    NSString *marker = info.isOrdered ? [NSString stringWithFormat:@"%ld.  ", (long)info.itemNumber] : @"•  ";

    NSDictionary *attrs = [text attributesAtIndex:info.position effectiveRange:NULL];
    NSAttributedString *markerString = [[NSAttributedString alloc] initWithString:marker attributes:attrs];
    [text insertAttributedString:markerString atIndex:info.position];
  }

  // Normalize indentation
  [text enumerateAttribute:ListDepthAttribute
                   inRange:NSMakeRange(0, text.length)
                   options:0
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if (!value || [value integerValue] < 0)
                    return;

                  NSInteger depth = [value integerValue];
                  CGFloat indent = depth * kListIndentPerLevel;

                  [text enumerateAttribute:NSParagraphStyleAttributeName
                                   inRange:range
                                   options:0
                                usingBlock:^(NSParagraphStyle *style, NSRange paraRange, BOOL *innerStop) {
                                  if (!style)
                                    return;

                                  NSMutableParagraphStyle *normalStyle = [style mutableCopy];
                                  normalStyle.firstLineHeadIndent = indent;
                                  normalStyle.headIndent = indent;
                                  [text addAttribute:NSParagraphStyleAttributeName value:normalStyle range:paraRange];
                                }];
                }];
}

#pragma mark - Thematic Break Processing

static void processThematicBreaks(NSMutableAttributedString *text)
{
  [text enumerateAttribute:NSAttachmentAttributeName
                   inRange:NSMakeRange(0, text.length)
                   options:NSAttributedStringEnumerationReverse
                usingBlock:^(id attachment, NSRange range, BOOL *stop) {
                  if (![attachment isKindOfClass:[ThematicBreakAttachment class]])
                    return;

                  NSMutableDictionary *attrs = [[text attributesAtIndex:range.location
                                                         effectiveRange:NULL] mutableCopy];
                  [attrs removeObjectForKey:NSAttachmentAttributeName];

                  NSAttributedString *replacement = [[NSAttributedString alloc] initWithString:@"\n---\n"
                                                                                    attributes:attrs];
                  [text replaceCharactersInRange:range withAttributedString:replacement];
                }];
}

#pragma mark - Public API

NSAttributedString *prepareAttributedStringForRTFExport(NSAttributedString *attributedString,
                                                        StyleConfig *_Nullable styleConfig)
{
  attributedString = ENRMAttributedStringByExpandingLinkPills(attributedString, NULL);
  if (!styleConfig)
    return attributedString;

  NSMutableAttributedString *prepared = [attributedString mutableCopy];

  RCTUIColor *codeBgColor = [styleConfig codeBackgroundColor];
  RCTUIColor *codeBlockBgColor = [styleConfig codeBlockBackgroundColor];
  RCTUIColor *blockquoteBgColor = [styleConfig blockquoteBackgroundColor];

  processThematicBreaks(prepared);
  processCodes(prepared, codeBgColor);
  processCodeBlocks(prepared, codeBlockBgColor);
  processBlockquotes(prepared, blockquoteBgColor);
  processLists(prepared);

  return prepared;
}
