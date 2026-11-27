#import "ENRMBoldStyleHandler.h"

@implementation ENRMBoldStyleHandler

- (ENRMInputStyleType)styleType
{
  return ENRMInputStyleTypeStrong;
}

- (ENRMStyleMergingConfig *)mergingConfig
{
  return [ENRMStyleMergingConfig emptyConfig];
}

- (UIFontDescriptorSymbolicTraits)fontTraits
{
  return UIFontDescriptorTraitBold;
}

- (void)applyNonFontAttributesToTextStorage:(NSTextStorage *)storage
                                      range:(NSRange)range
                            formattingRange:(ENRMFormattingRange *)formattingRange
                                      style:(ENRMInputFormatterStyle *)style
{
  if (style.boldColor) {
    [storage addAttribute:NSForegroundColorAttributeName value:style.boldColor range:range];
  }
}

@end
