#import "MarkdownAccessibilityElementBuilder.h"
#import "AccessibilityInfo.h"
#import "BlockquoteBorder.h"
#import "ENRMAccessibilityLabels.h"
#import "ENRMLinkPillAttachment.h"
#include <TargetConditionals.h>

typedef NS_ENUM(NSInteger, ElementType) { ElementTypeText, ElementTypeLink, ElementTypeImage };

static const CGFloat kFocusRectPadding = 2.0;

@implementation MarkdownAccessibilityElementBuilder

#if !TARGET_OS_OSX

#pragma mark - Public API

+ (NSMutableArray<UIAccessibilityElement *> *)buildElementsForTextView:(UITextView *)textView
                                                                  info:(AccessibilityInfo *)info
                                                                labels:(ENRMAccessibilityLabels *)labels
                                                             container:(id)container
{
  NSString *fullString = textView.attributedText.string;
  if (fullString.length == 0)
    return [NSMutableArray array];

  [textView.layoutManager ensureLayoutForTextContainer:textView.textContainer];

  NSMutableArray<UIAccessibilityElement *> *elements = [NSMutableArray array];
  NSUInteger currentPos = 0;

  while (currentPos < fullString.length) {
    NSRange paragraphRange = [fullString paragraphRangeForRange:NSMakeRange(currentPos, 0)];
    NSString *trimmed = [[fullString substringWithRange:paragraphRange]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];

    if (trimmed.length > 0) {
      NSArray *links = [self linksInRange:paragraphRange info:info];
      NSArray *images = [self imagesInRange:paragraphRange info:info];
      NSArray *specials = [links arrayByAddingObjectsFromArray:images];

      NSInteger level = [self headingLevelForRange:paragraphRange info:info];
      NSDictionary *list = [self listItemInfoForRange:paragraphRange info:info];

      if (specials.count == 0) {
        [elements addObject:[self createElementForRange:paragraphRange
                                                   type:ElementTypeText
                                                   text:trimmed
                                               isLinked:NO
                                                heading:level
                                               listInfo:list
                                                 labels:labels
                                                   view:textView
                                              container:container]];
      } else {
        [elements addObjectsFromArray:[self segmentedElementsForParagraph:paragraphRange
                                                                 fullText:fullString
                                                             headingLevel:level
                                                                 listInfo:list
                                                                 specials:specials
                                                                   labels:labels
                                                               inTextView:textView
                                                                container:container]];
      }
    }
    currentPos = NSMaxRange(paragraphRange);
  }
  return elements;
}

#pragma mark - Segmentation

+ (BOOL)hasAlphanumericContent:(NSString *)text
{
  static NSCharacterSet *alphanumericSet;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{ alphanumericSet = [NSCharacterSet alphanumericCharacterSet]; });
  return [text rangeOfCharacterFromSet:alphanumericSet].location != NSNotFound;
}

+ (NSArray<UIAccessibilityElement *> *)segmentedElementsForParagraph:(NSRange)paragraphRange
                                                            fullText:(NSString *)fullText
                                                        headingLevel:(NSInteger)headingLevel
                                                            listInfo:(NSDictionary *)listInfo
                                                            specials:(NSArray *)specials
                                                              labels:(ENRMAccessibilityLabels *)labels
                                                          inTextView:(UITextView *)textView
                                                           container:(id)container
{
  NSMutableArray<UIAccessibilityElement *> *elements = [NSMutableArray array];
  NSArray *sortedSpecials = [specials sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    return [@([a[@"range"] rangeValue].location) compare:@([b[@"range"] rangeValue].location)];
  }];

  NSUInteger segmentStart = paragraphRange.location;
  for (NSDictionary *item in sortedSpecials) {
    NSRange itemRange = [item[@"range"] rangeValue];

    if (itemRange.location > segmentStart) {
      NSRange beforeRange = NSMakeRange(segmentStart, itemRange.location - segmentStart);
      NSString *beforeText = [[fullText substringWithRange:beforeRange]
          stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
      if (beforeText.length > 0 && [self hasAlphanumericContent:beforeText]) {
        [elements addObject:[self createElementForRange:beforeRange
                                                   type:ElementTypeText
                                                   text:beforeText
                                               isLinked:NO
                                                heading:headingLevel
                                               listInfo:listInfo
                                                 labels:labels
                                                   view:textView
                                              container:container]];
      }
    }

    BOOL isImg = item[@"altText"] != nil;
    NSString *label = isImg ? item[@"altText"] : [fullText substringWithRange:itemRange];
    if (!isImg) {
      id attachment = [textView.textStorage attribute:NSAttachmentAttributeName
                                              atIndex:itemRange.location
                                       effectiveRange:NULL];
      if ([attachment isKindOfClass:ENRMLinkPillAttachment.class])
        label = [(ENRMLinkPillAttachment *)attachment linkAccessibilityLabel];
    }
    [elements addObject:[self createElementForRange:itemRange
                                               type:isImg ? ElementTypeImage : ElementTypeLink
                                               text:label
                                           isLinked:isImg ? [item[@"isLinked"] boolValue] : YES
                                            heading:0
                                           listInfo:listInfo
                                             labels:labels
                                               view:textView
                                          container:container]];
    segmentStart = NSMaxRange(itemRange);
  }

  if (segmentStart < NSMaxRange(paragraphRange)) {
    NSRange afterRange = NSMakeRange(segmentStart, NSMaxRange(paragraphRange) - segmentStart);
    NSString *afterText = [[fullText substringWithRange:afterRange]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (afterText.length > 0 && [self hasAlphanumericContent:afterText]) {
      [elements addObject:[self createElementForRange:afterRange
                                                 type:ElementTypeText
                                                 text:afterText
                                             isLinked:NO
                                              heading:headingLevel
                                             listInfo:listInfo
                                               labels:labels
                                                 view:textView
                                            container:container]];
    }
  }
  return elements;
}

#pragma mark - Factory

+ (UIAccessibilityElement *)createElementForRange:(NSRange)range
                                             type:(ElementType)type
                                             text:(NSString *)text
                                         isLinked:(BOOL)linked
                                          heading:(NSInteger)level
                                         listInfo:(NSDictionary *)listInfo
                                           labels:(ENRMAccessibilityLabels *)labels
                                             view:(UITextView *)textView
                                        container:(id)container
{
  UIAccessibilityElement *element = [[UIAccessibilityElement alloc] initWithAccessibilityContainer:container];
  if (text.length > 0)
    element.accessibilityLabel = text;

  element.accessibilityFrameInContainerSpace = [self frameForRange:range inTextView:textView container:container];

  if (type == ElementTypeImage) {
    element.accessibilityTraits =
        linked ? (UIAccessibilityTraitImage | UIAccessibilityTraitLink) : UIAccessibilityTraitImage;

  } else if (type == ElementTypeLink) {
    element.accessibilityTraits = UIAccessibilityTraitLink;
  } else if (level > 0) {
    element.accessibilityTraits = UIAccessibilityTraitHeader;
  }

  NSMutableArray<NSString *> *valueParts = [NSMutableArray array];
  NSString *listAnnouncement =
      (listInfo && type != ElementTypeImage) ? [self formatListAnnouncement:listInfo labels:labels] : nil;
  if (listAnnouncement) {
    [valueParts addObject:listAnnouncement];
  }
  NSString *blockquoteAnnouncement = [self blockquoteAnnouncementForRange:range textView:textView labels:labels];
  if (blockquoteAnnouncement) {
    [valueParts addObject:blockquoteAnnouncement];
  }
  if (valueParts.count > 0) {
    element.accessibilityValue = [valueParts componentsJoinedByString:@", "];
  }

  return element;
}

+ (NSString *)blockquoteAnnouncementForRange:(NSRange)range
                                    textView:(UITextView *)textView
                                      labels:(ENRMAccessibilityLabels *)labels
{
  NSTextStorage *storage = textView.textStorage;
  if (storage.length == 0 || range.location >= storage.length)
    return nil;
  NSRange effective;
  NSNumber *depth = [storage attribute:BlockquoteDepthAttributeName atIndex:range.location effectiveRange:&effective];
  if (depth == nil)
    return nil;
  return depth.integerValue >= 1 ? labels.nestedBlockquote : labels.blockquote;
}

#pragma mark - Helpers

+ (NSString *)formatListAnnouncement:(NSDictionary *)info labels:(ENRMAccessibilityLabels *)labels
{
  BOOL nested = [info[@"depth"] integerValue] > 1;
  if ([info[@"isOrdered"] boolValue]) {
    long position = (long)[info[@"position"] integerValue];
    NSString *template = nested ? labels.nestedOrderedItem : labels.orderedItem;
    return [template stringByReplacingOccurrencesOfString:@"{n}"
                                               withString:[NSString stringWithFormat:@"%ld", position]];
  }
  return nested ? labels.nestedBulletPoint : labels.bulletPoint;
}

+ (NSRange)clampedRange:(NSRange)range forText:(NSString *)text
{
  if (text.length == 0 || range.location >= text.length)
    return NSMakeRange(NSNotFound, 0);
  return NSMakeRange(range.location, MIN(range.length, text.length - range.location));
}

+ (CGRect)frameForRange:(NSRange)range inTextView:(UITextView *)textView container:(id)container
{
  NSRange clamped = [self clampedRange:range forText:textView.textStorage.string];
  if (clamped.location == NSNotFound)
    return CGRectZero;

  NSRange glyphRange = [textView.layoutManager glyphRangeForCharacterRange:clamped actualCharacterRange:NULL];
  CGRect rect = [textView.layoutManager boundingRectForGlyphRange:glyphRange inTextContainer:textView.textContainer];
  rect = CGRectInset(rect, -kFocusRectPadding, -kFocusRectPadding);
  rect = CGRectOffset(rect, textView.textContainerInset.left, textView.textContainerInset.top);
  return [(UIView *)container convertRect:CGRectIntegral(rect) fromView:textView];
}

#pragma mark - Data Helpers

+ (NSInteger)headingLevelForRange:(NSRange)range info:(AccessibilityInfo *)info
{
  for (NSUInteger i = 0; i < info.headingRanges.count; i++) {
    if (NSIntersectionRange(range, [info.headingRanges[i] rangeValue]).length > 0)
      return [info.headingLevels[i] integerValue];
  }
  return 0;
}

+ (NSArray *)linksInRange:(NSRange)range info:(AccessibilityInfo *)info
{
  NSMutableArray *links = [NSMutableArray array];
  for (NSUInteger i = 0; i < info.linkRanges.count; i++) {
    if (NSIntersectionRange(range, [info.linkRanges[i] rangeValue]).length > 0) {
      [links addObject:@{@"range" : info.linkRanges[i], @"url" : info.linkURLs[i] ?: @""}];
    }
  }
  return links;
}

+ (NSArray *)imagesInRange:(NSRange)range info:(AccessibilityInfo *)info
{
  NSMutableArray *images = [NSMutableArray array];
  for (NSUInteger i = 0; i < info.imageRanges.count; i++) {
    NSRange imgRange = [info.imageRanges[i] rangeValue];
    if (NSIntersectionRange(range, imgRange).length > 0) {
      BOOL linked = NO;
      for (NSValue *linkRange in info.linkRanges)
        if (NSIntersectionRange(imgRange, linkRange.rangeValue).length > 0) {
          linked = YES;
          break;
        }
      [images addObject:@{
        @"range" : info.imageRanges[i],
        @"altText" : info.imageAltTexts[i] ?: @"",
        @"isLinked" : @(linked)
      }];
    }
  }
  return images;
}

+ (NSDictionary *)listItemInfoForRange:(NSRange)range info:(AccessibilityInfo *)info
{
  if (!info)
    return nil;
  for (NSUInteger i = 0; i < info.listItemRanges.count; i++) {
    if (NSIntersectionRange(range, [info.listItemRanges[i] rangeValue]).length > 0) {
      return @{
        @"position" : info.listItemPositions[i],
        @"depth" : info.listItemDepths[i],
        @"isOrdered" : info.listItemOrdered[i]
      };
    }
  }
  return nil;
}

#pragma mark - Rotors

+ (NSArray *)filterElements:(NSArray *)elements withTrait:(UIAccessibilityTraits)trait
{
  return [elements
      filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(UIAccessibilityElement *element, id bindings) {
        return (element.accessibilityTraits & trait) != 0;
      }]];
}

+ (UIAccessibilityCustomRotor *)createRotorWithName:(NSString *)name elements:(NSArray *)elements
{
  return [[UIAccessibilityCustomRotor alloc]
         initWithName:name
      itemSearchBlock:^UIAccessibilityCustomRotorItemResult *(UIAccessibilityCustomRotorSearchPredicate *predicate) {
        if (elements.count == 0)
          return nil;
        NSInteger currentIndex = predicate.currentItem.targetElement
                                     ? [elements indexOfObject:predicate.currentItem.targetElement]
                                     : NSNotFound;
        NSInteger nextIndex = (predicate.searchDirection == UIAccessibilityCustomRotorDirectionNext)
                                  ? (currentIndex == NSNotFound ? 0 : currentIndex + 1)
                                  : (currentIndex == NSNotFound ? (NSInteger)elements.count - 1 : currentIndex - 1);
        return (nextIndex >= 0 && nextIndex < (NSInteger)elements.count)
                   ? [[UIAccessibilityCustomRotorItemResult alloc] initWithTargetElement:elements[nextIndex]
                                                                             targetRange:nil]
                   : nil;
      }];
}

+ (NSArray<UIAccessibilityElement *> *)filterHeadingElements:(NSArray *)elements
{
  return [self filterElements:elements withTrait:UIAccessibilityTraitHeader];
}
+ (NSArray<UIAccessibilityElement *> *)filterLinkElements:(NSArray *)elements
{
  return [self filterElements:elements withTrait:UIAccessibilityTraitLink];
}
+ (NSArray<UIAccessibilityElement *> *)filterImageElements:(NSArray *)elements
{
  return [self filterElements:elements withTrait:UIAccessibilityTraitImage];
}
+ (UIAccessibilityCustomRotor *)createHeadingRotorWithElements:(NSArray *)elements name:(NSString *)name
{
  return [self createRotorWithName:name elements:elements];
}
+ (UIAccessibilityCustomRotor *)createLinkRotorWithElements:(NSArray *)elements name:(NSString *)name
{
  return [self createRotorWithName:name elements:elements];
}
+ (UIAccessibilityCustomRotor *)createImageRotorWithElements:(NSArray *)elements name:(NSString *)name
{
  return [self createRotorWithName:name elements:elements];
}

+ (NSArray<UIAccessibilityCustomRotor *> *)buildRotorsFromElements:(NSArray<UIAccessibilityElement *> *)elements
                                                            labels:(ENRMAccessibilityLabels *)labels
{
  NSMutableArray<UIAccessibilityCustomRotor *> *rotors = [NSMutableArray array];

  NSArray<UIAccessibilityElement *> *headingElements = [self filterHeadingElements:elements];
  if (headingElements.count > 0) {
    [rotors addObject:[self createHeadingRotorWithElements:headingElements name:labels.rotorHeadings]];
  }

  NSArray<UIAccessibilityElement *> *linkElements = [self filterLinkElements:elements];
  if (linkElements.count > 0) {
    [rotors addObject:[self createLinkRotorWithElements:linkElements name:labels.rotorLinks]];
  }

  NSArray<UIAccessibilityElement *> *imageElements = [self filterImageElements:elements];
  if (imageElements.count > 0) {
    [rotors addObject:[self createImageRotorWithElements:imageElements name:labels.rotorImages]];
  }

  return rotors;
}

#else

// TODO: Implement VoiceOver accessibility elements for macOS using NSAccessibility.
// This includes building heading, link, and image accessibility elements from AttributedString
// attributes, and exposing them via NSAccessibilityElement so VoiceOver can navigate the
// rendered markdown content. The iOS implementation above can serve as a reference.

+ (NSMutableArray *)buildElementsForTextView:(id)textView
                                        info:(AccessibilityInfo *)info
                                      labels:(ENRMAccessibilityLabels *)labels
                                   container:(id)container
{
  return [NSMutableArray array];
}
+ (NSArray *)filterHeadingElements:(NSArray *)elements
{
  return @[];
}
+ (NSArray *)filterLinkElements:(NSArray *)elements
{
  return @[];
}
+ (NSArray *)filterImageElements:(NSArray *)elements
{
  return @[];
}
+ (id)createHeadingRotorWithElements:(NSArray *)elements name:(NSString *)name
{
  return nil;
}
+ (id)createLinkRotorWithElements:(NSArray *)elements name:(NSString *)name
{
  return nil;
}
+ (id)createImageRotorWithElements:(NSArray *)elements name:(NSString *)name
{
  return nil;
}
+ (NSArray *)buildRotorsFromElements:(NSArray *)elements labels:(ENRMAccessibilityLabels *)labels
{
  return @[];
}

#endif

@end
