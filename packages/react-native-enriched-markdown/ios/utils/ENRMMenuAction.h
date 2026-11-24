#pragma once
#include <TargetConditionals.h>

#if TARGET_OS_OSX
#import <AppKit/AppKit.h>

// NSMenuItem uses target/action with no block-based API, so we use a lightweight
// action object as the target. NSMenuItem.target is a WEAK reference (AppKit does
// not retain it), so we also store the action object in representedObject (strong)
// to tie its lifetime to the menu item.
@interface ENRMMenuAction : NSObject
- (instancetype)initWithBlock:(void (^)(void))block;
- (BOOL)validateMenuItem:(NSMenuItem *)menuItem;
- (void)performAction:(id)sender;
@end

/// Creates an NSMenuItem whose action fires a block.
static inline NSMenuItem *ENRMCreateMenuItem(NSString *title, void (^action)(void))
{
  ENRMMenuAction *actionObject = [[ENRMMenuAction alloc] initWithBlock:action];
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(performAction:) keyEquivalent:@""];
  item.target = actionObject;
  item.representedObject = actionObject;
  return item;
}

#endif // TARGET_OS_OSX
