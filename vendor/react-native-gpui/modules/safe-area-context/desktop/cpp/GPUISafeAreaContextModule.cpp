#include <GPUISafeAreaContextSpec.h>
#include <react/coremodules/DeviceInfoModule.h>
#include "GPUISafeAreaInsets.h"

#include <utility>

namespace {
using facebook::react::TurboModule;

class SafeAreaContextModule final
    : public facebook::react::NativeSafeAreaContextSpec<SafeAreaContextModule> {
 public:
  explicit SafeAreaContextModule(
      std::shared_ptr<facebook::react::CallInvoker> jsInvoker)
      : NativeSafeAreaContextSpec(std::move(jsInvoker)) {}

  facebook::jsi::Object getConstants(facebook::jsi::Runtime& runtime) {
    const auto windowSize = facebook::react::DeviceInfoModule::windowSize();
    facebook::jsi::Object insets(runtime);
    const auto safeInsets = gpui_safe_area::gpui_safe_area_insets(0);
    insets.setProperty(runtime, "top", safeInsets.top);
    insets.setProperty(runtime, "right", safeInsets.right);
    insets.setProperty(runtime, "bottom", safeInsets.bottom);
    insets.setProperty(runtime, "left", safeInsets.left);

    facebook::jsi::Object frame(runtime);
    frame.setProperty(runtime, "x", 0.0);
    frame.setProperty(runtime, "y", 0.0);
    frame.setProperty(runtime, "width", windowSize.width);
    frame.setProperty(runtime, "height", windowSize.height);

    facebook::jsi::Object metrics(runtime);
    metrics.setProperty(runtime, "insets", std::move(insets));
    metrics.setProperty(runtime, "frame", std::move(frame));

    facebook::jsi::Object constants(runtime);
    constants.setProperty(runtime, "initialWindowMetrics", std::move(metrics));
    return constants;
  }
};
} // namespace

std::shared_ptr<TurboModule> create_gpui_safe_area_context_module(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  return rngpui::provideTurboModule<SafeAreaContextModule>(
      name, std::move(jsInvoker));
}
