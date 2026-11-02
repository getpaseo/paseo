#pragma once

#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/ShadowNodeTraits.h>

namespace facebook::react::HostPlatformViewTraitsInitializer {
inline bool formsStackingContext(const ViewProps & /*props*/)
{
  return true;
}

inline bool formsView(const ViewProps & /*props*/)
{
  return false;
}

inline bool isKeyboardFocusable(const ViewProps &props)
{
  return props.focusable;
}

} // namespace facebook::react::HostPlatformViewTraitsInitializer
