#pragma once

#import "ENRMLinkRegexConfig.h"

#ifdef __cplusplus
// Props share EnrichedMarkdownTextInput's native regex transport.
template <typename RegexProps> static inline ENRMLinkRegexConfig *ENRMLinkRegexConfigFromProps(const RegexProps &props)
{
  if (props.isDisabled || props.isDefault || props.pattern.empty())
    return nil;
  return [ENRMLinkRegexConfig cachedConfigWithPattern:[NSString stringWithUTF8String:props.pattern.c_str()]
                                      caseInsensitive:props.caseInsensitive
                                               dotAll:props.dotAll];
}

template <typename RegexProps>
static inline BOOL ENRMLinkRegexPropsEqual(const RegexProps &oldProps, const RegexProps &newProps)
{
  return oldProps.isDisabled == newProps.isDisabled && oldProps.isDefault == newProps.isDefault &&
         oldProps.caseInsensitive == newProps.caseInsensitive && oldProps.dotAll == newProps.dotAll &&
         oldProps.pattern == newProps.pattern;
}
#endif
