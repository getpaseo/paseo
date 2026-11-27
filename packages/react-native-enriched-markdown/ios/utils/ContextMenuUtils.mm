#import "ContextMenuUtils.h"
#import "ENRMLinkPillText.h"
#import "ENRMMenuAction.h"

#if !TARGET_OS_OSX

// TODO: Remove API_AVAILABLE(ios(16.0)) guard when the minimum iOS deployment target in RN is bumped to 16.
NSMutableArray<UIAction *> *_Nullable ENRMBuildContextMenuActions(NSArray<NSString *> *itemTexts,
                                                                  NSArray<NSString *> *_Nullable iconNames,
                                                                  UITextView *textView, NSRange selectedRange,
                                                                  ENRMContextMenuPressHandler handler)
    API_AVAILABLE(ios(16.0))
{
  if (itemTexts.count == 0) {
    return nil;
  }

  NSString *selectedText =
      ENRMStringByExpandingLinkPills([textView.textStorage attributedSubstringFromRange:selectedRange]);
  NSUInteger selectionStart = selectedRange.location;
  NSUInteger selectionEnd = NSMaxRange(selectedRange);

  NSMutableArray<UIAction *> *actions = [NSMutableArray arrayWithCapacity:itemTexts.count];
  [itemTexts enumerateObjectsUsingBlock:^(NSString *itemText, NSUInteger index, BOOL *_) {
    NSString *iconName = iconNames ? iconNames[index] : nil;
    UIImage *image = iconName.length > 0 ? [UIImage systemImageNamed:iconName] : nil;
    [actions addObject:[UIAction actionWithTitle:itemText
                                           image:image
                                      identifier:nil
                                         handler:^(__kindof UIAction *_) {
                                           handler(itemText, selectedText, selectionStart, selectionEnd);
                                         }]];
  }];
  return actions;
}

#else

NSArray<NSMenuItem *> *_Nullable ENRMBuildContextMenuItems(NSArray<NSString *> *itemTexts,
                                                           NSArray<NSString *> *_Nullable iconNames,
                                                           NSTextView *textView, ENRMContextMenuPressHandler handler)
{
  if (itemTexts.count == 0) {
    return nil;
  }

  NSRange selectedRange = textView.selectedRange;
  NSString *selectedText = [textView.string substringWithRange:selectedRange];
  NSUInteger selectionStart = selectedRange.location;
  NSUInteger selectionEnd = NSMaxRange(selectedRange);

  NSMutableArray<NSMenuItem *> *items = [NSMutableArray arrayWithCapacity:itemTexts.count];
  [itemTexts enumerateObjectsUsingBlock:^(NSString *itemText, NSUInteger index, BOOL *_) {
    NSMenuItem *item =
        ENRMCreateMenuItem(itemText, ^{ handler(itemText, selectedText, selectionStart, selectionEnd); });
    NSString *iconName = iconNames ? iconNames[index] : nil;
    if (iconName.length > 0) {
      item.image = [NSImage imageWithSystemSymbolName:iconName accessibilityDescription:nil];
    }
    [items addObject:item];
  }];
  return items;
}

void ENRMPrependMenuItems(NSMenu *menu, NSArray<NSMenuItem *> *items)
{
  if (items.count == 0) {
    return;
  }
  [menu insertItem:[NSMenuItem separatorItem] atIndex:0];
  [items enumerateObjectsWithOptions:NSEnumerationReverse
                          usingBlock:^(NSMenuItem *item, NSUInteger _, BOOL *__) { [menu insertItem:item atIndex:0]; }];
}

#endif
