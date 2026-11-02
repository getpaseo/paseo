
#include "GpuiModules.h"

#include <folly/json.h>
#include <react/renderer/components/rnscreens/Props.h>

#include <string>

namespace rngpui {
namespace {

using namespace facebook::react;

std::string screenPropsJson(
    const std::string& /*componentName*/,
    const ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  auto props = std::dynamic_pointer_cast<const RNSScreenProps>(view.props);
  if (!props) {
    return std::string("{}");
  }
  folly::dynamic object = folly::dynamic::object;
  object["activityState"] = props->activityState;
  object["stackAnimation"] = toString(props->stackAnimation);
  object["stackPresentation"] = toString(props->stackPresentation);
  return folly::toJson(object);
}

std::string headerConfigPropsJson(
    const std::string& /*componentName*/,
    const ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  auto props = std::dynamic_pointer_cast<const RNSScreenStackHeaderConfigProps>(
      view.props);
  if (!props) {
    return std::string("{}");
  }
  folly::dynamic object = folly::dynamic::object;
  object["title"] = props->title;
  object["backgroundColor"] = argb(props->backgroundColor);
  object["titleColor"] = argb(props->titleColor);
  object["tintColor"] = argb(props->color);
  object["hidden"] = props->hidden;
  object["hideBackButton"] = props->hideBackButton;
  return folly::toJson(object);
}

std::string headerSubviewPropsJson(
    const std::string& /*componentName*/,
    const ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  auto props =
      std::dynamic_pointer_cast<const RNSScreenStackHeaderSubviewProps>(
          view.props);
  if (!props) {
    return std::string("{}");
  }
  folly::dynamic object = folly::dynamic::object;
  object["type"] = toString(props->type);
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_screens_module() {
  registerComponentProps("RNSScreen", screenPropsJson);
  registerComponentProps("RNSScreenStackHeaderConfig", headerConfigPropsJson);
  registerComponentProps("RNSScreenStackHeaderSubview", headerSubviewPropsJson);
}

} // namespace rngpui
