#import "BaselineShiftTextAttributes.h"

NSString *const ENRMScriptAttributeName = @"ENRMScript";
NSString *const ENRMScriptValueSuperscript = @"superscript";
NSString *const ENRMScriptValueSubscript = @"subscript";

void ENRMApplyBaselineShift(NSMutableAttributedString *output, NSRange range, CGFloat fontScale,
                            CGFloat baselineOffsetScale)
{
  [output enumerateAttribute:NSFontAttributeName
                     inRange:range
                     options:NSAttributedStringEnumerationLongestEffectiveRangeNotRequired
                  usingBlock:^(UIFont *font, NSRange fontRange, BOOL *stop) {
                    (void)stop;
                    if (![font isKindOfClass:UIFont.class]) {
                      return;
                    }

                    UIFont *scaledFont = [UIFont fontWithDescriptor:font.fontDescriptor
                                                               size:font.pointSize * fontScale];
                    [output addAttribute:NSFontAttributeName value:scaledFont range:fontRange];
                    [output addAttribute:NSBaselineOffsetAttributeName
                                   value:@(font.pointSize * baselineOffsetScale)
                                   range:fontRange];
                  }];
}
