
#include <react/renderer/components/scrollview/ScrollViewProps.h>
#include <react/renderer/components/scrollview/ScrollViewState.h>
#include <react/renderer/core/ConcreteState.h>

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"

namespace rngpui {
namespace {

std::string scrollViewPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  folly::dynamic object = folly::dynamic::object;
  bool horizontal = false;
  bool enabled = true;
  bool indicator = true;
  if (auto props =
          std::dynamic_pointer_cast<const facebook::react::ScrollViewProps>(
              view.props)) {
    horizontal = props->horizontal;
    enabled = props->scrollEnabled;
    indicator = props->horizontal ? props->showsHorizontalScrollIndicator
                                  : props->showsVerticalScrollIndicator;
  }
  object["horizontal"] = horizontal;
  object["enabled"] = enabled;
  object["indicator"] = indicator;
  if (auto state =
          std::dynamic_pointer_cast<const facebook::react::ConcreteState<
              facebook::react::ScrollViewState>>(view.state)) {
    const auto& data = state->getData();
    const auto content = data.getContentSize();
    object["contentWidth"] = content.width;
    object["contentHeight"] = content.height;
    object["offsetX"] = data.contentOffset.x;
    object["offsetY"] = data.contentOffset.y;
  }
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_scroll_view_module() {
  registerComponentProps("ScrollView", scrollViewPropsJson);
}

} // namespace rngpui
