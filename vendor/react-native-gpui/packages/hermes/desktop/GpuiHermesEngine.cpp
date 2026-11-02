#include "GpuiJsEngine.h"
#include "HermesNodeAddons.h"

#include <react/runtime/hermes/HermesInstance.h>

#include <memory>
#include <optional>
#include <utility>

#ifndef RN_GPUI_HERMES_VERSION
#define RN_GPUI_HERMES_VERSION ""
#endif

namespace {
class HermesRuntimeFactory final : public facebook::react::JSRuntimeFactory {
 public:
  std::unique_ptr<facebook::react::JSRuntime> createJSRuntime(
      std::shared_ptr<facebook::react::MessageQueueThread>
          msgQueueThread) noexcept override {
    return facebook::react::HermesInstance::createJSRuntime(
        nullptr, std::move(msgQueueThread), /* allocInOldGenBeforeTTI */ false);
  }
};

} // namespace

extern "C" void rn_gpui_register_js_engine_hermes() {
  rngpui::GpuiJsEngine engine{
      .info = {.name = "hermes", .version = RN_GPUI_HERMES_VERSION},
      .makeRuntimeFactory =
          [] { return std::make_shared<HermesRuntimeFactory>(); },
      // Hermes implements Node-API itself and ships the host-integration
      // interface (API/napi/hermes_napi.h) this package compiles against, so
      // `.node` loading is this engine's capability. Core owns everything else:
      // resolving the file, the cache and the error messages. On Windows the
      // symbols a stock addon imports are supplied by the app's executable,
      // which re-exports them forwarded to `hermesvm.dll` (see
      // `gpui/node-api-exports.txt` and
      // `rn-gpui-module-build::forward_node_api_exports`).
      .nodeAddons =
          rngpui::GpuiJsEngine::NodeAddons{
              .makeLoader = rngpui::makeHermesNodeAddonLoader},
  };
  rngpui::registerJsEngine(std::move(engine));
}
