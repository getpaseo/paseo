#import "EmphasisRenderer.h"
#import "FontUtils.h"
#import "MarkdownASTNode.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"
#import <React/RCTFont.h>

@implementation EmphasisRenderer

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
  RCTUIColor *configEmphasisColor = [_config emphasisColor];
  NSString *emphasisFontFamily = [_config emphasisFontFamily];
  NSString *emphasisFontStyle = [_config emphasisFontStyle];
  BOOL useNormalStyle = [emphasisFontStyle isEqualToString:@"normal"];

  // Cache the Strong color calculation to efficiently detect nested Strong nodes
  RCTUIColor *strongColorToPreserve = [_config strongColor] ? [RenderContext calculateStrongColor:[_config strongColor]
                                                                                       blockColor:blockStyle.color]
                                                            : nil;

  [output enumerateAttributesInRange:range
                             options:NSAttributedStringEnumerationLongestEffectiveRangeNotRequired
                          usingBlock:^(NSDictionary<NSAttributedStringKey, id> *attrs, NSRange subrange, BOOL *stop) {
                            UIFont *currentFont =
                                attrs[NSFontAttributeName] ?: cachedFontFromBlockStyle(blockStyle, context);
                            UIFont *resolvedFont = nil;

                            if (emphasisFontFamily.length > 0) {
                              resolvedFont = [RCTFont updateFont:currentFont
                                                      withFamily:emphasisFontFamily
                                                            size:nil
                                                          weight:nil
                                                           style:useNormalStyle ? nil : @"italic"
                                                         variant:nil
                                                 scaleMultiplier:1.0];
                            } else if (currentFont &&
                                       !(currentFont.fontDescriptor.symbolicTraits & UIFontDescriptorTraitItalic)) {
                              resolvedFont = [self ensureFontIsItalic:currentFont];
                            }

                            if (resolvedFont && ![resolvedFont isEqual:currentFont]) {
                              [output addAttribute:NSFontAttributeName value:resolvedFont range:subrange];
                            }

                            // 2. Color Optimization: Handle nesting and avoid redundant updates
                            if (configEmphasisColor) {
                              RCTUIColor *currentColor = attrs[NSForegroundColorAttributeName];
                              BOOL isLink = attrs[NSLinkAttributeName] != nil;

                              // Verify if the current color belongs to a Strong parent
                              BOOL isStrongColor =
                                  strongColorToPreserve && [currentColor isEqual:strongColorToPreserve];

                              // Preserving colors for higher-priority elements (links, strong nodes, etc.)
                              if (!isLink && !isStrongColor && ![RenderContext shouldPreserveColors:attrs]) {
                                // Only modify the string if the color is actually different
                                if (![currentColor isEqual:configEmphasisColor]) {
                                  [output addAttribute:NSForegroundColorAttributeName
                                                 value:configEmphasisColor
                                                 range:subrange];
                                }
                              }
                            }
                          }];
}

#pragma mark - Helper Methods

- (UIFont *)ensureFontIsItalic:(UIFont *)font
{
  if (!font)
    return nil;

  UIFontDescriptorSymbolicTraits traits = font.fontDescriptor.symbolicTraits;
  if (traits & UIFontDescriptorTraitItalic)
    return font;

  // Combine italic with existing traits (e.g., preserving Bold if present)
  UIFontDescriptorSymbolicTraits combinedTraits = traits | UIFontDescriptorTraitItalic;
  UIFontDescriptor *italicDescriptor = [font.fontDescriptor fontDescriptorWithSymbolicTraits:combinedTraits];

  // Size 0 in fontWithDescriptor:size: maintains the current point size
  return [UIFont fontWithDescriptor:italicDescriptor size:0] ?: font;
}

@end