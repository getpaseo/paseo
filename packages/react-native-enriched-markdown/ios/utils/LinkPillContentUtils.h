#pragma once

#import "StyleConfig.h"
#import <Foundation/Foundation.h>

#ifdef __cplusplus
#import <React/RCTConversions.h>
#include <vector>

// The `linkPillContent` prop: per-link pill label and icon, keyed by exact URL.

template <typename T>
static bool ENRMLinkPillContentChanged(const std::vector<T> &oldContent, const std::vector<T> &newContent)
{
  if (newContent.size() != oldContent.size()) {
    return true;
  }
  for (size_t i = 0; i < newContent.size(); i++) {
    if (newContent[i].url != oldContent[i].url || newContent[i].label != oldContent[i].label ||
        newContent[i].iconUri != oldContent[i].iconUri || newContent[i].iconTintColor != oldContent[i].iconTintColor) {
      return true;
    }
  }
  return false;
}

template <typename T>
static NSDictionary<NSString *, LinkPillContent *> *_Nullable ENRMLinkPillContentFromProps(
    const std::vector<T> &content)
{
  if (content.empty()) {
    return nil;
  }
  NSMutableDictionary<NSString *, LinkPillContent *> *result =
      [NSMutableDictionary dictionaryWithCapacity:content.size()];
  for (const auto &entry : content) {
    LinkPillContent *value = [[LinkPillContent alloc] init];
    value.label = @(entry.label.c_str());
    value.iconUri = @(entry.iconUri.c_str());
    value.iconTintColor = entry.iconTintColor ? RCTUIColorFromSharedColor(entry.iconTintColor) : nil;
    result[@(entry.url.c_str())] = value;
  }
  return [result copy];
}

#endif
