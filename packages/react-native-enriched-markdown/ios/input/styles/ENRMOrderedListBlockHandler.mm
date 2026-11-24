#import "ENRMOrderedListBlockHandler.h"
#import "ENRMInputBlockType.h"

@implementation ENRMOrderedListBlockHandler

- (ENRMInputBlockType)blockType
{
  return ENRMInputBlockTypeOrderedListItem;
}

- (BOOL)continuesOnNewline
{
  return YES;
}

- (void)applyAttributesToParagraphStyle:(NSMutableParagraphStyle *)paragraphStyle
                             attributes:(NSMutableDictionary<NSAttributedStringKey, id> *)attributes
                             blockRange:(ENRMBlockRange *)blockRange
                                  style:(ENRMInputFormatterStyle *)style
{
  NSInteger depth = blockRange.level;
  if (depth < 0) {
    depth = 0;
  } else if (depth > kENRMMaxListDepth) {
    depth = kENRMMaxListDepth;
  }

  // Same indent column as the bullet handler so mixed lists align; wrapped
  // lines hang under the text, not under the number.
  CGFloat indent = (depth + 1) * kENRMListIndentPerDepth;
  paragraphStyle.firstLineHeadIndent = indent;
  paragraphStyle.headIndent = indent;
  paragraphStyle.paragraphSpacingBefore = style.listItemSpacing;
}

- (NSString *)markdownLinePrefixForBlockRange:(ENRMBlockRange *)blockRange
{
  NSInteger depth = blockRange.level;
  if (depth < 0) {
    depth = 0;
  } else if (depth > kENRMMaxListDepth) {
    depth = kENRMMaxListDepth;
  }
  NSString *indent = [@"" stringByPaddingToLength:depth * 3 withString:@" " startingAtIndex:0];
  return [indent stringByAppendingFormat:@"%ld. ", (long)blockRange.ordinal];
}

@end
