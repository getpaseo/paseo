// Props for the native root, read by the Rust renderer as JSON. Registered the
// way `shortcut_scope/GpuiShortcutScopeProps.cpp` is.

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"
#include "react/renderer/components/nativeroot/NativeRoot.h"

namespace rngpui {
namespace {

std::string nativeRootPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props =
      *std::static_pointer_cast<const facebook::react::NativeRootProps>(
          view.props);
  folly::dynamic object = folly::dynamic::object;
  object["rootId"] = props.rootId;
  object["hinted"] = props.hintHeight >= 0;
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_native_root_module() {
  registerComponentProps("DesktopNativeRoot", nativeRootPropsJson);
}

} // namespace rngpui
