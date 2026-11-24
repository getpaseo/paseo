#import "LinkRenderer.h"
#import "CodeBackground.h"
#import "ENRMLinkPillAttachment.h"
#import "ENRMSpoilerTapUtils.h"
#import "ENRMTextLinkAttributes.h"
#import "FontUtils.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"
#import <React/RCTFont.h>

#if !TARGET_OS_OSX
static BOOL ENRMRangeHasAttribute(NSAttributedString *text, NSRange range, NSAttributedStringKey key)
{
  __block BOOL found = NO;
  [text enumerateAttribute:key
                   inRange:range
                   options:0
                usingBlock:^(id value, NSRange subrange, BOOL *stop) {
                  if (value) {
                    found = YES;
                    *stop = YES;
                  }
                }];
  return found;
}

/// Replaces the rendered link content with one attachment character and returns its range.
static NSRange ENRMCollapseLinkIntoPill(NSMutableAttributedString *output, NSRange range, NSString *url,
                                        LinkVariantConfig *variant, StyleConfig *config, RenderContext *context)
{
  LinkPillContent *content = [config linkPillContent][url];
  BOOL hasOwnIcon = content.iconUri.length > 0;
  // A tint set for the link wins. The variant's tint is for the variant's own icon, not for an
  // icon supplied per link (an avatar would become a silhouette).
  RCTUIColor *iconTint = content.iconTintColor ?: (hasOwnIcon ? nil : variant.pill.iconTintColor);
  NSDictionary<NSAttributedStringKey, id> *attributes = [output attributesAtIndex:range.location effectiveRange:NULL];
  ENRMLinkPillAttachment *pill = [[ENRMLinkPillAttachment alloc]
      initWithOriginalText:[output attributedSubstringFromRange:range]
                   variant:variant
                     label:content.label.length > 0 ? content.label : variant.pill.label
                   iconUri:hasOwnIcon ? content.iconUri : variant.pill.iconUri
             iconTintColor:iconTint
                      font:attributes[NSFontAttributeName] ?: [context getBlockStyle].cachedFont
            requestHeaders:[config imageRequestHeaders]];
  pill.lineHeight = [config lineHeightForLinkPill:variant.pill];

  // The placeholder keeps the block context of the text it replaces. The pill draws its own
  // background, underline and label, so inline decoration of that text must not show around it.
  NSMutableDictionary<NSAttributedStringKey, id> *placeholder = [attributes mutableCopy];
  [placeholder removeObjectsForKeys:@[
    NSBackgroundColorAttributeName, NSUnderlineStyleAttributeName, NSUnderlineColorAttributeName,
    NSStrikethroughStyleAttributeName, CodeAttributeName
  ]];
  placeholder[NSAttachmentAttributeName] = pill;
  [output replaceCharactersInRange:range
              withAttributedString:[[NSAttributedString alloc] initWithString:@"\uFFFC" attributes:placeholder]];
  return NSMakeRange(range.location, 1);
}
#endif

@implementation LinkRenderer

#pragma mark - Rendering

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  BOOL recognizedLink = [node.attributes[@"recognizedLink"] isEqualToString:@"true"];
  NSUInteger start = output.length;

  // 1. Render children first to establish base attributes
  [_rendererFactory renderChildrenOfNode:node into:output context:context];

  NSRange range = NSMakeRange(start, output.length - start);
  if (range.length == 0)
    return;

  // 2. Extract configuration
  NSString *url = node.attributes[@"url"] ?: @"";
  LinkVariantConfig *variant = [_config effectiveLinkVariantForURL:url];

  RCTUIColor *linkColor = variant.color ?: [_config linkColor];
  BOOL linkUnderline = variant ? variant.underline : [_config linkUnderline];
  NSString *linkFontFamily = variant.fontFamily.length > 0 ? variant.fontFamily : [_config linkFontFamily];
  RCTUIColor *backgroundColor = variant ? variant.backgroundColor : [_config linkBackgroundColor];

  NSNumber *underlineStyle = @(linkUnderline ? NSUnderlineStyleSingle : NSUnderlineStyleNone);

  // 3. Apply core link functionality (non-destructive)
  [output addAttribute:NSLinkAttributeName value:url range:range];

  // 4. Optimize visual attributes via enumeration to avoid redundant updates
  [output enumerateAttributesInRange:range
                             options:NSAttributedStringEnumerationLongestEffectiveRangeNotRequired
                          usingBlock:^(NSDictionary<NSAttributedStringKey, id> *attrs, NSRange subrange, BOOL *stop) {
                            NSMutableDictionary *newAttributes = [NSMutableDictionary dictionary];
                            newAttributes[@"linkSourceType"] =
                                recognizedLink ? (attrs[CodeAttributeName] ? @"inline-code" : @"text") : @"markdown";
                            if (recognizedLink) {
                              newAttributes[ENRMRecognizedLinkAttributeName] = @YES;
                              newAttributes[ENRMRecognizedLinkOriginalUnderlineAttributeName] =
                                  attrs[NSUnderlineStyleAttributeName] ?: @0;
                            }

                            // Only apply link color if the subrange isn't already colored by the link style
                            if (linkColor && ![attrs[NSForegroundColorAttributeName] isEqual:linkColor]) {
                              newAttributes[NSForegroundColorAttributeName] = linkColor;
                              newAttributes[NSUnderlineColorAttributeName] = linkColor;
                            }

                            // Only update underline style if it differs from the config
                            if (![attrs[NSUnderlineStyleAttributeName] isEqual:underlineStyle]) {
                              newAttributes[NSUnderlineStyleAttributeName] = underlineStyle;
                            }

                            if (linkFontFamily.length > 0) {
                              UIFont *currentFont = attrs[NSFontAttributeName];
                              if (currentFont) {
                                UIFont *linkFont = [RCTFont updateFont:currentFont
                                                            withFamily:linkFontFamily
                                                                  size:nil
                                                                weight:nil
                                                                 style:nil
                                                               variant:nil
                                                       scaleMultiplier:1.0];
                                if (linkFont && ![currentFont isEqual:linkFont]) {
                                  newAttributes[NSFontAttributeName] = linkFont;
                                }
                              }
                            }

                            if (newAttributes.count > 0) {
                              [output addAttributes:newAttributes range:subrange];
                            }
                          }];

#if !TARGET_OS_OSX
  // A pill is one line and one unit: links holding attachments or a line break stay ordinary links.
  // So do links holding a spoiler, whose hidden text the label would show.
  BOOL willBePill =
      variant.pill != nil && !ENRMRangeHasAttribute(output, range, NSAttachmentAttributeName) &&
      !ENRMRangeHasAttribute(output, range, SpoilerAttributeName) &&
      [output.string rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet options:0 range:range].location ==
          NSNotFound;
#else
  BOOL willBePill = NO;
#endif
  if (backgroundColor && !willBePill)
    [output addAttribute:NSBackgroundColorAttributeName value:backgroundColor range:range];

#if !TARGET_OS_OSX
  if (willBePill)
    range = ENRMCollapseLinkIntoPill(output, range, url, variant, _config, context);
#endif
  [context registerLinkRange:range url:url];
}

@end