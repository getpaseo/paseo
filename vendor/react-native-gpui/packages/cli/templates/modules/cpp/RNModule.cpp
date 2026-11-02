#include "RNModule.hpp"

#include <RNModuleSpec.h>

#include <memory>
#include <string>
#include <utility>

namespace {
namespace jsi = facebook::jsi;
using facebook::react::CallInvoker;
using facebook::react::TurboModule;

class RNModule final : public facebook::react::NativeModuleSpec<RNModule> {
 public:
  explicit RNModule(std::shared_ptr<CallInvoker> jsInvoker)
      : NativeModuleSpec(std::move(jsInvoker)) {}

  std::string greet(jsi::Runtime&, std::string name) {
    return "Hello from C++, " + name + "!";
  }
};
} // namespace

std::shared_ptr<TurboModule> create_rn_module(
    const std::string& name,
    std::shared_ptr<CallInvoker> jsInvoker) {
  return rngpui::provideTurboModule<RNModule>(name, std::move(jsInvoker));
}
