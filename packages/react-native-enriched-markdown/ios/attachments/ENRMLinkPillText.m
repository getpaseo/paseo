#import "ENRMLinkPillText.h"
#import "ENRMLinkPillAttachment.h"

#if !TARGET_OS_OSX

/// Inline parents (strong, emphasis) restyle the placeholder's font after the pill was created; carry that over.
static UIFont *ENRMFontAddingTraits(UIFont *font, UIFontDescriptorSymbolicTraits traits)
{
  UIFontDescriptorSymbolicTraits current = font.fontDescriptor.symbolicTraits;
  if ((current & traits) == traits)
    return font;
  UIFontDescriptor *descriptor = [font.fontDescriptor fontDescriptorWithSymbolicTraits:current | traits];
  return descriptor ? [UIFont fontWithDescriptor:descriptor size:font.pointSize] : font;
}

static NSAttributedString *ENRMExpandedLinkPill(ENRMLinkPillAttachment *pill, NSDictionary *placeholderAttributes)
{
  NSMutableAttributedString *expanded = [pill.originalText mutableCopy];
  NSRange all = NSMakeRange(0, expanded.length);
  // The placeholder started with the font of the link's first character, so only traits it has
  // gained since come from an enclosing parent.
  UIFont *placeholderFont = placeholderAttributes[NSFontAttributeName];
  UIFont *firstFont = all.length > 0 ? [expanded attribute:NSFontAttributeName atIndex:0 effectiveRange:NULL] : nil;
  UIFontDescriptorSymbolicTraits inherited = placeholderFont.fontDescriptor.symbolicTraits &
                                             ~firstFont.fontDescriptor.symbolicTraits &
                                             (UIFontDescriptorTraitBold | UIFontDescriptorTraitItalic);
  [placeholderAttributes enumerateKeysAndObjectsUsingBlock:^(NSAttributedStringKey key, id value, BOOL *stop) {
    if ([key isEqualToString:NSAttachmentAttributeName])
      return;
    BOOL isFont = [key isEqualToString:NSFontAttributeName];
    [pill.originalText enumerateAttribute:key
                                  inRange:all
                                  options:0
                               usingBlock:^(id existing, NSRange range, BOOL *innerStop) {
                                 if (!existing) {
                                   [expanded addAttribute:key value:value range:range];
                                 } else if (isFont && inherited != 0) {
                                   [expanded addAttribute:key
                                                    value:ENRMFontAddingTraits(existing, inherited)
                                                    range:range];
                                 }
                               }];
  }];
  return expanded;
}

#endif

void ENRMLinkPillsAdoptPlaceholderFonts(NSAttributedString *text)
{
#if !TARGET_OS_OSX
  [text enumerateAttribute:NSAttachmentAttributeName
                   inRange:NSMakeRange(0, text.length)
                   options:NSAttributedStringEnumerationLongestEffectiveRangeNotRequired
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if ([value isKindOfClass:ENRMLinkPillAttachment.class])
                    [(ENRMLinkPillAttachment *)value adoptFont:[text attribute:NSFontAttributeName
                                                                          atIndex:range.location
                                                                   effectiveRange:NULL]];
                }];
#endif
}

NSAttributedString *ENRMAttributedStringByExpandingLinkPills(NSAttributedString *text, NSRange *ioRange)
{
#if TARGET_OS_OSX
  return text;
#else
  if (text.length == 0)
    return text;
  NSMutableArray<NSValue *> *ranges = nil;
  NSMutableArray<ENRMLinkPillAttachment *> *pills = nil;
  NSRange all = NSMakeRange(0, text.length);
  NSRange cursor = NSMakeRange(0, 0);
  while (NSMaxRange(cursor) < text.length) {
    id value = [text attribute:NSAttachmentAttributeName
                       atIndex:NSMaxRange(cursor)
         longestEffectiveRange:&cursor
                       inRange:all];
    if (![value isKindOfClass:ENRMLinkPillAttachment.class])
      continue;
    if (!pills) {
      ranges = [NSMutableArray new];
      pills = [NSMutableArray new];
    }
    [ranges addObject:[NSValue valueWithRange:cursor]];
    [pills addObject:value];
  }
  if (!pills)
    return text;

  NSMutableAttributedString *result = [text mutableCopy];
  NSRange range = ioRange ? *ioRange : NSMakeRange(0, 0);
  NSInteger locationDelta = 0;
  NSInteger lengthDelta = 0;
  // Back to front, so earlier ranges stay valid while the string grows.
  for (NSInteger i = (NSInteger)pills.count - 1; i >= 0; i--) {
    NSRange placeholder = ranges[i].rangeValue;
    NSAttributedString *expanded = ENRMExpandedLinkPill(pills[i], [text attributesAtIndex:placeholder.location
                                                                           effectiveRange:NULL]);
    [result replaceCharactersInRange:placeholder withAttributedString:expanded];
    NSInteger growth = (NSInteger)expanded.length - (NSInteger)placeholder.length;
    if (NSMaxRange(placeholder) <= range.location) {
      locationDelta += growth;
    } else if (placeholder.location < NSMaxRange(range)) {
      lengthDelta += growth;
    }
  }
  if (ioRange)
    *ioRange = NSMakeRange(range.location + locationDelta, range.length + lengthDelta);
  return result;
#endif
}

NSString *ENRMStringByExpandingLinkPills(NSAttributedString *text)
{
  return ENRMAttributedStringByExpandingLinkPills(text, NULL).string;
}
