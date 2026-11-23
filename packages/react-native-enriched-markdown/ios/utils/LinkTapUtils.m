#import "LinkTapUtils.h"
#import "ENRMLinkPillAttachment.h"
#import "ENRMSpoilerTapUtils.h"
#import "ENRMTextHitTest.h"

NSString *_Nullable linkURLAtTapLocation(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer)
{
  NSUInteger characterIndex = ENRMCharacterIndexForTap(textView, recognizer);
  if (characterIndex == NSNotFound)
    return nil;

  NSAttributedString *attrText = ENRMGetAttributedText(textView);
  return [attrText attribute:@"linkURL" atIndex:characterIndex effectiveRange:NULL];
}

NSString *linkSourceTypeAtTapLocation(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer)
{
  NSUInteger index = ENRMCharacterIndexForTap(textView, recognizer);
  if (index == NSNotFound)
    return @"markdown";
  return [ENRMGetAttributedText(textView) attribute:@"linkSourceType" atIndex:index effectiveRange:NULL] ?: @"markdown";
}

NSString *_Nullable linkURLAtPoint(ENRMPlatformTextView *textView, CGPoint point)
{
  NSUInteger index = ENRMCharacterIndexAtPoint(textView, point);
  if (index == NSNotFound)
    return nil;
  return [ENRMGetAttributedText(textView) attribute:@"linkURL" atIndex:index effectiveRange:NULL];
}

NSString *_Nullable linkURLAtRange(ENRMPlatformTextView *textView, NSRange characterRange)
{
  NSAttributedString *attrText = ENRMGetAttributedText(textView);
  if (characterRange.location >= attrText.length) {
    return nil;
  }
  return [attrText attribute:@"linkURL" atIndex:characterRange.location effectiveRange:NULL];
}

NSString *_Nullable linkTitleAtIndex(NSAttributedString *text, NSUInteger index)
{
  if (index >= text.length)
    return nil;
#if !TARGET_OS_OSX
  id attachment = [text attribute:NSAttachmentAttributeName atIndex:index effectiveRange:NULL];
  if ([attachment isKindOfClass:ENRMLinkPillAttachment.class])
    return ((ENRMLinkPillAttachment *)attachment).label;
#endif
  NSRange range;
  id url = [text attribute:@"linkURL" atIndex:index longestEffectiveRange:&range inRange:NSMakeRange(0, text.length)];
  return url ? [text.string substringWithRange:range] : nil;
}

NSDictionary<NSString *, NSString *> *_Nullable imageAtTapLocation(ENRMPlatformTextView *textView,
                                                                   ENRMTapRecognizer *recognizer)
{
  NSUInteger characterIndex = ENRMCharacterIndexForTap(textView, recognizer);
  if (characterIndex == NSNotFound)
    return nil;

  NSAttributedString *attrText = ENRMGetAttributedText(textView);
  if ([attrText attribute:@"linkURL" atIndex:characterIndex effectiveRange:NULL] != nil)
    return nil;

  NSString *url = [attrText attribute:@"imageURL" atIndex:characterIndex effectiveRange:NULL];
  if (!url)
    return nil;

  NSString *altText = [attrText attribute:@"imageAltText" atIndex:characterIndex effectiveRange:NULL];
  return @{@"url" : url, @"altText" : altText ?: @""};
}

NSDictionary<NSString *, NSString *> *_Nullable codeBlockAtTapLocation(ENRMPlatformTextView *textView,
                                                                       ENRMTapRecognizer *recognizer)
{
  NSUInteger characterIndex = ENRMCharacterIndexForTap(textView, recognizer);
  if (characterIndex == NSNotFound)
    return nil;

  NSAttributedString *attrText = ENRMGetAttributedText(textView);
  NSString *code = [attrText attribute:@"codeBlockText" atIndex:characterIndex effectiveRange:NULL];
  if (!code)
    return nil;

  NSString *language = [attrText attribute:@"codeBlockLanguage" atIndex:characterIndex effectiveRange:NULL];
  return @{@"code" : code, @"language" : language ?: @""};
}

BOOL isPointOnInteractiveElement(ENRMPlatformTextView *textView, CGPoint point, BOOL includeImages,
                                 BOOL includeCodeBlock)
{
  NSUInteger charIndex = ENRMCharacterIndexAtPoint(textView, point);
  if (charIndex == NSNotFound)
    return NO;

  NSDictionary *attrs = [ENRMGetAttributedText(textView) attributesAtIndex:charIndex effectiveRange:NULL];
  if (attrs[@"linkURL"] != nil || [attrs[@"TaskItem"] boolValue] || attrs[SpoilerAttributeName] != nil)
    return YES;

  if (includeImages && attrs[@"imageURL"] != nil)
    return YES;

  return includeCodeBlock && attrs[@"codeBlockText"] != nil;
}
