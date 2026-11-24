#import "ENRMLinkStyleHandler.h"

static ENRMInputLinkVariantStyle *ENRMResolveInputLinkVariant(ENRMInputFormatterStyle *style, NSString *url)
{
  NSRange urlRange = NSMakeRange(0, url.length);
  for (ENRMInputLinkVariantStyle *variant in style.linkVariants) {
    if ([variant.regex firstMatchInString:url options:0 range:urlRange] != nil) {
      return variant;
    }
  }
  return nil;
}

@implementation ENRMLinkStyleHandler

- (ENRMInputStyleType)styleType
{
  return ENRMInputStyleTypeLink;
}

- (ENRMStyleMergingConfig *)mergingConfig
{
  return [ENRMStyleMergingConfig emptyConfig];
}

- (UIFontDescriptorSymbolicTraits)fontTraits
{
  return 0;
}

- (void)applyNonFontAttributesToTextStorage:(NSTextStorage *)storage
                                      range:(NSRange)range
                            formattingRange:(ENRMFormattingRange *)formattingRange
                                      style:(ENRMInputFormatterStyle *)style
{
  ENRMInputLinkVariantStyle *variant = ENRMResolveInputLinkVariant(style, formattingRange.url);
  RCTUIColor *linkColor = variant.color ?: style.linkColor;
  BOOL linkUnderline = variant ? variant.underline : style.linkUnderline;
  RCTUIColor *backgroundColor = variant ? variant.backgroundColor : style.linkBackgroundColor;

  if (linkColor != nil) {
    [storage addAttribute:NSForegroundColorAttributeName value:linkColor range:range];
  }
  if (linkUnderline) {
    [storage addAttribute:NSUnderlineStyleAttributeName value:@(NSUnderlineStyleSingle) range:range];
  }
  if (backgroundColor != nil) {
    [storage addAttribute:NSBackgroundColorAttributeName value:backgroundColor range:range];
  }
}

@end
