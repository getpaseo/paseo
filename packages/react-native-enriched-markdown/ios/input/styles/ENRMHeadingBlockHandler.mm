#import "ENRMHeadingBlockHandler.h"
#import "ParagraphStyleUtils.h"

@implementation ENRMHeadingBlockHandler

- (ENRMInputBlockType)blockType
{
  return ENRMInputBlockTypeHeading1;
}

- (void)applyAttributesToParagraphStyle:(NSMutableParagraphStyle *)paragraphStyle
                             attributes:(NSMutableDictionary<NSAttributedStringKey, id> *)attributes
                             blockRange:(ENRMBlockRange *)blockRange
                                  style:(ENRMInputFormatterStyle *)style
{
  NSInteger level = blockRange.level;
  if (level < 1 || level > 6) {
    return;
  }

  attributes[NSFontAttributeName] = [style headingFontForLevel:level];

  RCTUIColor *headingColor = [style headingColorForLevel:level];
  if (headingColor) {
    attributes[NSForegroundColorAttributeName] = headingColor;
  }

  ENRMApplyLineHeightToParagraphStyle(paragraphStyle, [style derivedLineHeightForHeadingLevel:level]);
}

- (NSString *)markdownLinePrefixForBlockRange:(ENRMBlockRange *)blockRange
{
  NSInteger level = blockRange.level;
  if (level < 1 || level > 6) {
    return @"";
  }
  NSString *hashes = [@"" stringByPaddingToLength:level withString:@"#" startingAtIndex:0];
  return [hashes stringByAppendingString:@" "];
}

@end
