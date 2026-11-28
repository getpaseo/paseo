
#include <react/renderer/components/iostextinput/TextInputProps.h>
#include <react/renderer/components/textinput/TextInputState.h>
#include <react/renderer/core/ConcreteState.h>

#include <folly/json.h>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>

#include "GpuiModules.h"

namespace rngpui {
namespace {

uint32_t argb(const facebook::react::SharedColor& color) {
  if (!color) {
    return 0;
  }
  auto components = facebook::react::colorComponentsFromColor(color);
  auto to8 = [](float value) {
    return static_cast<uint32_t>(std::lround(value * 255.f)) & 0xFF;
  };
  return (to8(components.alpha) << 24) | (to8(components.red) << 16) |
      (to8(components.green) << 8) | to8(components.blue);
}

std::string textInputPropsJson(
    const std::string& /*componentName*/,
    const facebook::react::ShadowView& view) {
  folly::dynamic object = folly::dynamic::object;
  if (auto props =
          std::dynamic_pointer_cast<const facebook::react::TextInputProps>(
              view.props)) {
    object["text"] = props->text;
    object["placeholder"] = props->placeholder;
    object["selectionColor"] = static_cast<double>(argb(props->selectionColor));
    object["multiline"] = props->multiline;
    object["placeholderTextColor"] =
        static_cast<double>(argb(props->placeholderTextColor));
    switch (props->submitBehavior) {
      case facebook::react::SubmitBehavior::Submit:
        object["submitBehavior"] = "submit";
        break;
      case facebook::react::SubmitBehavior::BlurAndSubmit:
        object["submitBehavior"] = "blurAndSubmit";
        break;
      case facebook::react::SubmitBehavior::Newline:
        object["submitBehavior"] = "newline";
        break;
      default:
        object["submitBehavior"] = "default";
        break;
    }
    if (props->maxLength != std::numeric_limits<int>::max()) {
      object["maxLength"] = props->maxLength;
    }
    object["contextMenuHidden"] = props->traits.contextMenuHidden;
    object["caretHidden"] = props->traits.caretHidden;
    object["selectTextOnFocus"] = props->traits.selectTextOnFocus;
    object["editable"] = props->editable && !props->readOnly;
    object["secure"] = props->traits.secureTextEntry;
    object["eventCount"] = props->mostRecentEventCount;
    bool selection_set = props->selection.has_value();
    object["selectionSet"] = selection_set;
    if (selection_set) {
      object["selectionStart"] = props->selection->start;
      object["selectionEnd"] = props->selection->end;
    } else {
      int32_t cursor = 0;
      for (const auto byte : props->text) {
        const auto value = static_cast<unsigned char>(byte);
        if ((value & 0xC0) != 0x80) {
          cursor += value >= 0xF0 ? 2 : 1;
        }
      }
      object["selectionStart"] = cursor;
      object["selectionEnd"] = cursor;
    }
  }
  return folly::toJson(object);
}

} // namespace

void rn_gpui_install_text_input_module() {
  registerComponentProps("TextInput", textInputPropsJson);
}

} // namespace rngpui
