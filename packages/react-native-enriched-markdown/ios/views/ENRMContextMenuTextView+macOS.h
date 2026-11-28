#pragma once
#include <TargetConditionals.h>

#if TARGET_OS_OSX
#import "ENRMUIKit.h"

typedef NSMenu *_Nullable (^ENRMContextMenuProvider)(NSMenu *baseMenu, NSTextView *textView);

/// macOS-only ENRMPlatformTextView subclass that manages context menus
/// and text deselection across sibling text views.
@interface ENRMContextMenuTextView : ENRMPlatformTextView <NSMenuDelegate>

@property (nonatomic, copy, nullable) ENRMContextMenuProvider contextMenuProvider;

@end

#endif // TARGET_OS_OSX
