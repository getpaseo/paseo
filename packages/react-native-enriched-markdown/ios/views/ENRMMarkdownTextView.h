#pragma once
#import "ENRMUIKit.h"

#import "ENRMLinkContextMenus.h"

#if !TARGET_OS_OSX
NS_ASSUME_NONNULL_BEGIN

/**
 * The read-only text view markdown renders into. A link pill is one placeholder character
 * in text storage; what the system reads for the selection (Look Up, Translate, Share,
 * drag, the Copy key command) is answered here with the link text the pill stands for.
 *
 * It also presents the menu of a pill that has one, taken from a delegate that is an
 * `ENRMLinkContextMenuSource`: UIKit lifts a pressed text item on a tinted box of its own,
 * which hides the pill's look.
 */
@interface ENRMMarkdownTextView : UITextView <ENRMLinkMenuPresenting>
/// Copies a selection the way the menu Copy does. Set by the hosting view, which knows the
/// source Markdown and style; without it the Copy key command writes plain text and RTF only.
@property (nonatomic, copy, nullable) void (^copySelectionHandler)(NSRange selectedRange);
@end

NS_ASSUME_NONNULL_END
#endif
