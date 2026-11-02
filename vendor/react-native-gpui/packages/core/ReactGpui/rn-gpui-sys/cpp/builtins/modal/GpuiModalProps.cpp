
#include <react/renderer/components/modal/ModalHostViewShadowNode.h>

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"

namespace rngpui {
namespace {

std::string modalPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  const auto props =
      std::dynamic_pointer_cast<const facebook::react::ModalHostViewProps>(
          view.props);
  folly::dynamic object = folly::dynamic::object;
  object["visible"] = props ? props->visible : true;
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_modal_module() {
  registerComponentProps("ModalHostView", modalPropsJson);
}

} // namespace rngpui
