#import "ENRMContextMenuTextView+macOS.h"
#include <TargetConditionals.h>

#if TARGET_OS_OSX

@implementation ENRMContextMenuTextView

- (NSScrollView *)enclosingScrollView
{
  return nil;
}

- (void)deselectAllInContainer
{
  NSView *container = self.superview.superview;
  if (!container)
    return;

  for (NSView *segment in container.subviews) {
    for (NSView *child in segment.subviews) {
      if ([child isKindOfClass:[ENRMContextMenuTextView class]]) {
        ENRMContextMenuTextView *tv = (ENRMContextMenuTextView *)child;
        if (tv.selectedRange.length > 0) {
          tv.selectedRange = NSMakeRange(0, 0);
        }
      }
    }
  }
}

- (void)mouseDown:(NSEvent *)event
{
  [self deselectAllInContainer];
  [super mouseDown:event];

  if (self.selectedRange.length > 0) {
    NSMenu *menu = [self menuForEvent:event];
    if (menu) {
      NSPoint locationInView = [self convertPoint:self.window.mouseLocationOutsideOfEventStream fromView:nil];
      [menu popUpMenuPositioningItem:nil atLocation:locationInView inView:self];
    }
  }
}

- (void)rightMouseDown:(NSEvent *)event
{
  [self deselectAllInContainer];
  [super rightMouseDown:event];
}

- (NSMenu *)menuForEvent:(NSEvent *)event
{
  NSMenu *baseMenu = [super menuForEvent:event];
  if (!baseMenu)
    return nil;

  static NSSet<NSString *> *unwantedTitles;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    unwantedTitles = [NSSet setWithObjects:@"Font", @"Spelling and Grammar", @"Substitutions", @"Transformations",
                                           @"Writing Direction", @"Layout Orientation", nil];
  });

  for (NSInteger i = baseMenu.numberOfItems - 1; i >= 0; i--) {
    NSMenuItem *item = [baseMenu itemAtIndex:i];
    BOOL isUnwanted = (item.submenu && [unwantedTitles containsObject:item.submenu.title]);
    BOOL isRedundantSeparator = (i > 0 && item.isSeparatorItem && [baseMenu itemAtIndex:i - 1].isSeparatorItem);

    if (isUnwanted || isRedundantSeparator) {
      [baseMenu removeItemAtIndex:i];
    }
  }

  while (baseMenu.numberOfItems > 0 && [baseMenu itemAtIndex:baseMenu.numberOfItems - 1].isSeparatorItem) {
    [baseMenu removeItemAtIndex:baseMenu.numberOfItems - 1];
  }

  if (self.contextMenuProvider && self.selectedRange.length > 0) {
    NSMenu *customMenu = self.contextMenuProvider(baseMenu, self);
    customMenu.delegate = self;
    return customMenu;
  }

  return baseMenu;
}

- (void)menuDidClose:(NSMenu *)menu
{
  if (menu.delegate == self) {
    self.selectedRange = NSMakeRange(0, 0);
    menu.delegate = nil;
  }
}

@end

#endif
