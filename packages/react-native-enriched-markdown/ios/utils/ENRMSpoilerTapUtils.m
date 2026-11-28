#import "ENRMSpoilerTapUtils.h"
#import "ENRMSpoilerOverlayManager.h"
#import "ENRMTextHitTest.h"

NSString *const SpoilerAttributeName = @"Spoiler";
NSString *const SpoilerOriginalColorAttributeName = @"SpoilerOriginalColor";

// Expands outward because internal formatting can split the attribute into multiple runs.
static NSRange expandSpoilerRange(NSTextStorage *textStorage, NSUInteger index)
{
  NSRange run;
  [textStorage attribute:SpoilerAttributeName atIndex:index effectiveRange:&run];

  NSUInteger start = run.location;
  NSUInteger end = NSMaxRange(run);
  NSUInteger length = textStorage.length;

  while (start > 0) {
    if (![textStorage attribute:SpoilerAttributeName atIndex:start - 1 effectiveRange:&run])
      break;
    start = run.location;
  }

  while (end < length) {
    if (![textStorage attribute:SpoilerAttributeName atIndex:end effectiveRange:&run])
      break;
    end = NSMaxRange(run);
  }

  return NSMakeRange(start, end - start);
}

void ENRMRestoreSpoilerTextColors(NSTextStorage *textStorage, NSRange range)
{
  [textStorage beginEditing];
  [textStorage enumerateAttribute:SpoilerOriginalColorAttributeName
                          inRange:range
                          options:0
                       usingBlock:^(id value, NSRange subRange, BOOL *stop) {
                         if (value) {
                           [textStorage addAttribute:NSForegroundColorAttributeName value:value range:subRange];
                           [textStorage removeAttribute:SpoilerOriginalColorAttributeName range:subRange];
                         }
                       }];
  [textStorage endEditing];
}

BOOL handleSpoilerTap(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer,
                      ENRMSpoilerOverlayManager *spoilerManager)
{
  NSUInteger characterIndex = ENRMCharacterIndexForTap(textView, recognizer);
  if (characterIndex == NSNotFound)
    return NO;

  NSTextStorage *textStorage = textView.textStorage;
  if (![textStorage attribute:SpoilerAttributeName atIndex:characterIndex effectiveRange:NULL])
    return NO;

  NSRange fullRange = expandSpoilerRange(textStorage, characterIndex);

  [textStorage beginEditing];
  [textStorage removeAttribute:SpoilerAttributeName range:fullRange];
  ENRMRestoreSpoilerTextColors(textStorage, fullRange);
  [textStorage endEditing];

  [spoilerManager removeOverlaysForCharRange:fullRange];
  return YES;
}
