#pragma once

#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

#ifdef __cplusplus
#include <string>
#include <vector>

template <typename T>
static bool ENRMContextMenuItemsChanged(const std::vector<T> &oldItems, const std::vector<T> &newItems)
{
  if (newItems.size() != oldItems.size()) {
    return true;
  }
  for (size_t i = 0; i < newItems.size(); i++) {
    if (newItems[i].text != oldItems[i].text || newItems[i].icon != oldItems[i].icon) {
      return true;
    }
  }
  return false;
}

template <typename T> static NSArray<NSString *> *ENRMContextMenuTextsFromItems(const std::vector<T> &items)
{
  NSMutableArray<NSString *> *result = [NSMutableArray new];
  for (const auto &item : items) {
    [result addObject:[NSString stringWithUTF8String:item.text.c_str()]];
  }
  return [result copy];
}

template <typename T> static NSArray<NSString *> *_Nullable ENRMContextMenuIconsFromItems(const std::vector<T> &items)
{
  NSMutableArray<NSString *> *result = [NSMutableArray arrayWithCapacity:items.size()];
  bool hasAnyIcon = false;
  for (const auto &item : items) {
    NSString *iconName = @(item.icon.c_str());
    hasAnyIcon = hasAnyIcon || iconName.length > 0;
    [result addObject:iconName];
  }
  return hasAnyIcon ? [result copy] : nil;
}

#endif

typedef void (^ENRMContextMenuPressHandler)(NSString *_Nonnull itemText, NSString *_Nonnull selectedText,
                                            NSUInteger selectionStart, NSUInteger selectionEnd);

#ifdef __cplusplus
extern "C" {
#endif

#if !TARGET_OS_OSX

// TODO: Remove API_AVAILABLE(ios(16.0)) guard when the minimum iOS deployment target in RN is bumped to 16.
NSMutableArray<UIAction *> *_Nullable ENRMBuildContextMenuActions(NSArray<NSString *> *_Nonnull itemTexts,
                                                                  NSArray<NSString *> *_Nullable iconNames,
                                                                  UITextView *_Nonnull textView, NSRange selectedRange,
                                                                  ENRMContextMenuPressHandler _Nonnull handler)
    API_AVAILABLE(ios(16.0));

#else

NSArray<NSMenuItem *> *_Nullable ENRMBuildContextMenuItems(NSArray<NSString *> *_Nonnull itemTexts,
                                                           NSArray<NSString *> *_Nullable iconNames,
                                                           NSTextView *_Nonnull textView,
                                                           ENRMContextMenuPressHandler _Nonnull handler);

void ENRMPrependMenuItems(NSMenu *_Nonnull menu, NSArray<NSMenuItem *> *_Nullable items);

#endif

#ifdef __cplusplus
}
#endif
