// Props for `ActivityIndicatorView`, read by the Rust renderer as JSON.

#include <folly/json.h>
#include <string>

#include <react/renderer/components/FBReactNativeSpec/Props.h>

#include "GpuiModules.h"

namespace rngpui {
namespace {

std::string activityIndicatorPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props = *std::static_pointer_cast<
      const facebook::react::ActivityIndicatorViewProps>(view.props);
  folly::dynamic object = folly::dynamic::object;
  object["animating"] = props.animating;
  object["hidesWhenStopped"] = props.hidesWhenStopped;
  object["color"] = argb(props.color);
  object["size"] = facebook::react::toString(props.size);
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_activity_indicator_module() {
  registerComponentProps("ActivityIndicatorView", activityIndicatorPropsJson);
}

} // namespace rngpui
