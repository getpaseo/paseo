
#include <react/renderer/components/image/ImageProps.h>

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"

namespace rngpui {
namespace {

std::string imagePropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props =
      *std::static_pointer_cast<const facebook::react::ImageProps>(view.props);
  folly::dynamic object = folly::dynamic::object;
  if (!props.sources.empty()) {
    object["uri"] = props.sources[0].uri;
  }
  switch (props.resizeMode) {
    case facebook::react::ImageResizeMode::Contain:
      object["resizeMode"] = "contain";
      break;
    case facebook::react::ImageResizeMode::Cover:
      object["resizeMode"] = "cover";
      break;
    case facebook::react::ImageResizeMode::Center:
      object["resizeMode"] = "center";
      break;
    default:
      object["resizeMode"] = "stretch";
      break;
  }
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_image_module() {
  registerComponentProps("Image", imagePropsJson);
}

} // namespace rngpui
