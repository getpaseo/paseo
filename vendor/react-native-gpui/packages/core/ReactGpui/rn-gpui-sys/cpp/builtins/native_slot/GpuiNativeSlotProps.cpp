// Props for a native slot, read by the Rust renderer as JSON. Registered the
// way `shortcut_scope/GpuiShortcutScopeProps.cpp` is.

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"
#include "react/renderer/components/nativeslot/NativeSlot.h"

namespace rngpui {
namespace {

std::string nativeSlotPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props =
      *std::static_pointer_cast<const facebook::react::NativeSlotProps>(
          view.props);
  folly::dynamic object = folly::dynamic::object;
  object["rootId"] = props.rootId;
  object["slotId"] = props.slotId;
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_native_slot_module() {
  registerComponentProps("DesktopNativeSlot", nativeSlotPropsJson);
}

} // namespace rngpui
