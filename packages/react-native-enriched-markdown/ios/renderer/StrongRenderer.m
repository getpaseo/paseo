#import "StrongRenderer.h"
#import "FontUtils.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"
#import <React/RCTFont.h>

@implementation StrongRenderer

#pragma mark - Rendering

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  NSUInteger start = output.length;
  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  NSRange range = NSMakeRange(start, output.length - start);
  if (range.length == 0)
    return;

  BlockStyle *blockStyle = [context getBlockStyle];
  RCTUIColor *configStrongColor = [_config strongColor];
  RCTUIColor *calculatedColor =
      configStrongColor ? [RenderContext calculateStrongColor:configStrongColor blockColor:blockStyle.color] : nil;
  NSString *strongFontFamily = [_config strongFontFamily];
  NSString *strongFontWeight = [_config strongFontWeight];
  BOOL useNormalWeight = [strongFontWeight isEqualToString:@"normal"];

  [output enumerateAttributesInRange:range
                             options:NSAttributedStringEnumerationLongestEffectiveRangeNotRequired
                          usingBlock:^(NSDictionary<NSAttributedStringKey, id> *attrs, NSRange subrange, BOOL *stop) {
                            // 1. Resolve Font
                            UIFont *currentFont =
                                attrs[NSFontAttributeName] ?: cachedFontFromBlockStyle(blockStyle, context);

                            UIFont *resolvedFont = currentFont;

                            if (strongFontFamily.length > 0) {
                              NSString *weight = useNormalWeight ? nil : @"bold";
                              resolvedFont = [RCTFont updateFont:currentFont
                                                      withFamily:strongFontFamily
                                                            size:nil
                                                          weight:weight
                                                           style:nil
                                                         variant:nil
                                                 scaleMultiplier:1.0];
                            } else if (!([currentFont.fontDescriptor symbolicTraits] & UIFontDescriptorTraitBold)) {
                              resolvedFont = [self ensureFontIsBold:currentFont];
                            }

                            if (resolvedFont && ![resolvedFont isEqual:currentFont]) {
                              [output addAttribute:NSFontAttributeName value:resolvedFont range:subrange];
                            }

                            // 2. Resolve Color
                            // Only apply if we have a color and the current segment doesn't explicitly forbid overrides
                            if (calculatedColor && ![RenderContext shouldPreserveColors:attrs]) {
                              // Optimization: Check if this color is already set to avoid redundant attribute changes
                              if (![attrs[NSForegroundColorAttributeName] isEqual:calculatedColor]) {
                                [output addAttribute:NSForegroundColorAttributeName
                                               value:calculatedColor
                                               range:subrange];
                              }
                            }
                          }];
}

#pragma mark - Helper Methods

- (UIFont *)ensureFontIsBold:(UIFont *)font
{
  if (!font)
    return nil;

  UIFontDescriptor *descriptor = font.fontDescriptor;
  UIFontDescriptorSymbolicTraits traits = descriptor.symbolicTraits;

  // Create new descriptor combining current traits with Bold
  UIFontDescriptor *boldDescriptor = [descriptor fontDescriptorWithSymbolicTraits:(traits | UIFontDescriptorTraitBold)];

  // Fallback to original font if bold version is unavailable
  return boldDescriptor ? [UIFont fontWithDescriptor:boldDescriptor size:0] : font;
}

@end