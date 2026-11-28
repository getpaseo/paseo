#include "GpuiMarkdownBridge.h"
#include "GpuiModules.h"

#include <react/renderer/components/EnrichedMarkdownTextSpec/Props.h>

#include <string>

namespace rngpui {
using namespace facebook::react;

void rn_gpui_install_enriched_markdown_module() {
  registerComponentProps(
      "EnrichedMarkdown", [](const std::string& /*name*/, const ShadowView& view) -> std::string {
        if (auto typed = std::dynamic_pointer_cast<const EnrichedMarkdownProps>(view.props)) {
          return rngpui::markdown::serializePropsJson(*typed, true);
        }
        return "{}";
      });
  registerComponentProps(
      "EnrichedMarkdownText",
      [](const std::string& /*name*/, const ShadowView& view) -> std::string {
        if (auto typed = std::dynamic_pointer_cast<const EnrichedMarkdownTextProps>(view.props)) {
          return rngpui::markdown::serializePropsJson(*typed, false);
        }
        return "{}";
      });
}

} // namespace rngpui
