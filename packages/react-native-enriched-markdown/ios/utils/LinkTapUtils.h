#pragma once

#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Returns the link URL at the tap location, or nil if no link was tapped.
NSString *_Nullable linkURLAtTapLocation(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer);

/// Returns the syntax of the link at the tap location.
NSString *linkSourceTypeAtTapLocation(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer);

/// Returns the original link URL at a point in text-view coordinates.
NSString *_Nullable linkURLAtPoint(ENRMPlatformTextView *textView, CGPoint point);

/// Returns the link URL at the given character range, or nil if none found.
NSString *_Nullable linkURLAtRange(ENRMPlatformTextView *textView, NSRange characterRange);

/// What the user sees the link at `index` as: its pill label, or its text. Nil when there is no link.
NSString *_Nullable linkTitleAtIndex(NSAttributedString *text, NSUInteger index);

/// Returns the tapped image as @{@"url": ..., @"altText": ...}, or nil if the
/// tap did not land on an image. A linked image resolves to its link (the
/// linkURL attribute wins), so this returns nil for it.
NSDictionary<NSString *, NSString *> *_Nullable imageAtTapLocation(ENRMPlatformTextView *textView,
                                                                   ENRMTapRecognizer *recognizer);

/// Returns the tapped code block as @{@"code": ..., @"language": ...}, or nil if
/// the tap did not land on a commonmark code block.
NSDictionary<NSString *, NSString *> *_Nullable codeBlockAtTapLocation(ENRMPlatformTextView *textView,
                                                                       ENRMTapRecognizer *recognizer);

/// Returns YES if the point (in textView coordinates) is on a link or task list
/// checkbox. When `includeImages` is YES, images also count as interactive
/// (used to stop a parent press handler once `onImagePress` is enabled), and
/// likewise `includeCodeBlock` for `onCodeBlockPress`.
BOOL isPointOnInteractiveElement(ENRMPlatformTextView *textView, CGPoint point, BOOL includeImages,
                                 BOOL includeCodeBlock);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
