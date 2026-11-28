// Props for `Switch`, read by the Rust renderer as JSON.

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"
#include "react/renderer/components/desktopswitch/DesktopSwitch.h"

namespace rngpui {
namespace {

std::string switchPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props =
      *std::static_pointer_cast<const facebook::react::SwitchProps>(view.props);
  folly::dynamic object = folly::dynamic::object;
  object["value"] = props.value;
  object["disabled"] = props.disabled;
  object["tintColor"] = argb(props.tintColor);
  object["onTintColor"] = argb(props.onTintColor);
  object["thumbTintColor"] = argb(props.thumbTintColor);
  object["thumbColor"] = argb(props.thumbColor);
  object["trackColorForFalse"] = argb(props.trackColorForFalse);
  object["trackColorForTrue"] = argb(props.trackColorForTrue);
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_switch_module() {
  registerComponentProps("Switch", switchPropsJson);
}

} // namespace rngpui
