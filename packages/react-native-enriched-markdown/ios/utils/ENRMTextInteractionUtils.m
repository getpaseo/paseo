#import "ENRMTextInteractionUtils.h"
#import "LinkTapUtils.h"

BOOL ENRMHandleTapOnTextView(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer,
                             void (^onLinkPress)(NSString *url, NSString *sourceType))
{
  NSString *url = linkURLAtTapLocation(textView, recognizer);
  if (!url) {
    ENRMClearSelection(textView);
    return NO;
  }
  if (onLinkPress)
    onLinkPress(url, linkSourceTypeAtTapLocation(textView, recognizer));
  return YES;
}
