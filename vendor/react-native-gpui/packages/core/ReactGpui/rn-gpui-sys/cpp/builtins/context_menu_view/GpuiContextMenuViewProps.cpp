// Props for the native context-menu view, read by the Rust renderer as JSON.
//
// Registered the way core's other built-ins are (see
// `window_control/GpuiWindowControlProps.cpp`): an installer listed in
// `cpp/CMakeLists.txt`, called once by the generated
// `rn_gpui_install_modules()`.
//
// `items` goes out as-is. It is the same `MenuItemSpec[]` shape
// `contextMenuShow` takes, so the Rust side parses both with one function and a
// menu cannot mean one thing from JS and another from this component.

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"
#include "react/renderer/components/desktopcontextmenuview/DesktopContextMenuView.h"

namespace rngpui {
namespace {

std::string contextMenuViewPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props = *std::static_pointer_cast<
      const facebook::react::DesktopContextMenuViewProps>(view.props);
  folly::dynamic object = folly::dynamic::object;
  object["items"] = props.items;
  object["presentation"] = props.presentation;
  object["disabled"] = props.disabled;
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_context_menu_view_module() {
  registerComponentProps("DesktopContextMenuView", contextMenuViewPropsJson);
}

} // namespace rngpui
