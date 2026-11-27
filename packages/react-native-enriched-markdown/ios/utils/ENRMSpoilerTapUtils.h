#pragma once

#import "ENRMUIKit.h"

@class ENRMSpoilerOverlayManager;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

extern NSString *const SpoilerAttributeName;
extern NSString *const SpoilerOriginalColorAttributeName;

BOOL handleSpoilerTap(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer,
                      ENRMSpoilerOverlayManager *spoilerManager);

void ENRMRestoreSpoilerTextColors(NSTextStorage *textStorage, NSRange range);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
