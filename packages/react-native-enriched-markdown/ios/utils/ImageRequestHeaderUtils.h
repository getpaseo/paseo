#pragma once

#import <Foundation/Foundation.h>

#ifdef __cplusplus
#include <vector>

template <typename T>
static bool ENRMImageRequestHeadersChanged(const std::vector<T> &oldHeaders, const std::vector<T> &newHeaders)
{
  if (newHeaders.size() != oldHeaders.size()) {
    return true;
  }
  for (size_t i = 0; i < newHeaders.size(); i++) {
    if (newHeaders[i].name != oldHeaders[i].name || newHeaders[i].value != oldHeaders[i].value) {
      return true;
    }
  }
  return false;
}

template <typename T>
static NSDictionary<NSString *, NSString *> *_Nullable ENRMImageRequestHeadersFromProps(const std::vector<T> &headers)
{
  if (headers.empty()) {
    return nil;
  }
  NSMutableDictionary<NSString *, NSString *> *result = [NSMutableDictionary dictionaryWithCapacity:headers.size()];
  for (const auto &header : headers) {
    result[@(header.name.c_str())] = @(header.value.c_str());
  }
  return [result copy];
}

#endif
