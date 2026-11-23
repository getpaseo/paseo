#import "ENRMItalicStyleHandler.h"

@implementation ENRMItalicStyleHandler

- (ENRMInputStyleType)styleType
{
  return ENRMInputStyleTypeEmphasis;
}

- (ENRMStyleMergingConfig *)mergingConfig
{
  return [ENRMStyleMergingConfig emptyConfig];
}

- (UIFontDescriptorSymbolicTraits)fontTraits
{
  return UIFontDescriptorTraitItalic;
}

- (void)applyNonFontAttributesToTextStorage:(NSTextStorage *)storage
                                      range:(NSRange)range
                            formattingRange:(ENRMFormattingRange *)formattingRange
                                      style:(ENRMInputFormatterStyle *)style
{
  if (style.italicColor) {
    [storage addAttribute:NSForegroundColorAttributeName value:style.italicColor range:range];
  }
}

@end
