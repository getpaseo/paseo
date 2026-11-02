// Props for the shortcut scope, read by the Rust renderer as JSON.
//
// Registered the way core's other built-ins are (see
// `window_control/GpuiWindowControlProps.cpp`): an installer listed in
// `cpp/CMakeLists.txt`, called once by the generated
// `rn_gpui_install_modules()`.
//
// The props are one string. Everything the component means is native — the
// `name` becomes a keymap context and GPUI resolves the precedence — so there
// is nothing else to send.

#include <folly/json.h>
#include <string>

#include "GpuiModules.h"
#include "react/renderer/components/shortcutscope/ShortcutScope.h"

namespace rngpui {
namespace {

std::string shortcutScopePropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  if (!view.props) {
    return std::string("{}");
  }
  const auto& props =
      *std::static_pointer_cast<const facebook::react::ShortcutScopeProps>(
          view.props);
  folly::dynamic object = folly::dynamic::object;
  object["name"] = props.name;
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_shortcut_scope_module() {
  registerComponentProps("DesktopShortcutScope", shortcutScopePropsJson);
}

} // namespace rngpui
