#pragma once

#import "ENRMLinkContextMenus.h"
#import <Foundation/Foundation.h>

#ifdef __cplusplus
#include <vector>

// The `linkContextMenuItems` prop: link long-press menu items by URL pattern.

template <typename T>
static bool ENRMLinkContextMenuItemsChanged(const std::vector<T> &oldMenus, const std::vector<T> &newMenus)
{
  if (newMenus.size() != oldMenus.size()) {
    return true;
  }
  for (size_t i = 0; i < newMenus.size(); i++) {
    const auto &oldItems = oldMenus[i].items;
    const auto &newItems = newMenus[i].items;
    if (newMenus[i].pattern != oldMenus[i].pattern || newItems.size() != oldItems.size()) {
      return true;
    }
    for (size_t j = 0; j < newItems.size(); j++) {
      if (newItems[j].text != oldItems[j].text || newItems[j].icon != oldItems[j].icon ||
          newItems[j].disabled != oldItems[j].disabled || newItems[j].destructive != oldItems[j].destructive) {
        return true;
      }
    }
  }
  return false;
}

template <typename T>
static NSArray<ENRMLinkContextMenuEntry *> *_Nonnull ENRMLinkContextMenuEntriesFromProps(const std::vector<T> &menus)
{
  NSMutableArray<ENRMLinkContextMenuEntry *> *entries = [NSMutableArray arrayWithCapacity:menus.size()];
  for (const auto &menu : menus) {
    NSMutableArray<ENRMLinkContextMenuItem *> *items = [NSMutableArray arrayWithCapacity:menu.items.size()];
    for (const auto &source : menu.items) {
      ENRMLinkContextMenuItem *item = [[ENRMLinkContextMenuItem alloc] init];
      item.text = @(source.text.c_str());
      item.icon = @(source.icon.c_str());
      item.disabled = source.disabled;
      item.destructive = source.destructive;
      [items addObject:item];
    }
    ENRMLinkContextMenuEntry *entry = [[ENRMLinkContextMenuEntry alloc] init];
    entry.pattern = @(menu.pattern.c_str());
    entry.items = items;
    [entries addObject:entry];
  }
  return entries;
}

#endif
