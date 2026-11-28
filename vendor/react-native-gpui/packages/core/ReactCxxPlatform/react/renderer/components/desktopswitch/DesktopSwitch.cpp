#include "DesktopSwitch.h"

#include <react/renderer/core/LayoutConstraints.h>

namespace facebook::react {

const char DesktopSwitchComponentName[] = "Switch";

Size DesktopSwitchShadowNode::measureContent(
    const LayoutContext& /*layoutContext*/,
    const LayoutConstraints& layoutConstraints) const {
#if defined(__APPLE__)
  const Size size{38, 22};
#elif defined(_WIN32)
  const Size size{40, 20};
#else
  const Size size{46, 26};
#endif
  return layoutConstraints.clamp(size);
}

} // namespace facebook::react
