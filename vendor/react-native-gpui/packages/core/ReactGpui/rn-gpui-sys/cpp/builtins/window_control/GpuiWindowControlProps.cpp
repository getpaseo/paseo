// Props for the caption button, read by the Rust renderer as JSON.
//
// Registered the way core's other built-ins are (see
// `image/GpuiImageProps.cpp`): an installer listed in `cpp/CMakeLists.txt`,
// called once by the generated `rn_gpui_install_modules()`.

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"
#include "react/renderer/components/windowcontrol/WindowControl.h"

namespace rngpui {
namespace {

std::string windowControlPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props =
      *std::static_pointer_cast<const facebook::react::WindowControlProps>(
          view.props);
  folly::dynamic object = folly::dynamic::object;
  switch (props.action) {
    case facebook::react::WindowControlAction::Minimize:
      object["action"] = "minimize";
      break;
    case facebook::react::WindowControlAction::Maximize:
      object["action"] = "maximize";
      break;
    default:
      object["action"] = "close";
      break;
  }
  object["disabled"] = props.disabled;
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_window_control_module() {
  registerComponentProps("DesktopWindowControl", windowControlPropsJson);
}

} // namespace rngpui
