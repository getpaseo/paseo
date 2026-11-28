// Props for the scrollbar component, read by the Rust renderer as JSON.
//
// Only what the app set is sent, so the scroll view keeps its defaults for the
// rest. Registered the way `shortcut_scope/GpuiShortcutScopeProps.cpp` is.

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"
#include "react/renderer/components/desktopscrollbar/DesktopScrollBar.h"

namespace rngpui {
namespace {

std::string desktopScrollBarPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props =
      *std::static_pointer_cast<const facebook::react::DesktopScrollBarProps>(
          view.props);
  folly::dynamic object = folly::dynamic::object;
  const auto number = [&](const char* key, double value) {
    if (value >= 0) {
      object[key] = value;
    }
  };
  number("thickness", props.thickness);
  number("minLength", props.minLength);
  number("margin", props.margin);
  number("radius", props.radius);
  number("autoHideDelay", props.autoHideDelay);
  if (argb(props.color) != 0) {
    object["color"] = argb(props.color);
  }
  if (argb(props.trackColor) != 0) {
    object["trackColor"] = argb(props.trackColor);
  }
  if (!props.visibility.empty()) {
    object["visibility"] = props.visibility;
  }
  object["interactive"] = props.interactive;
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_desktop_scroll_bar_module() {
  registerComponentProps("DesktopScrollBar", desktopScrollBarPropsJson);
}

} // namespace rngpui
