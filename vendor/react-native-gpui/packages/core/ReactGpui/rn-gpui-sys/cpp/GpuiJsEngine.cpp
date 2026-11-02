#include "GpuiJsEngine.h"

#include <mutex>

namespace rngpui {
namespace {
std::mutex& registryMutex() {
  static std::mutex mutex;
  return mutex;
}

std::vector<GpuiJsEngine>& registry() {
  static std::vector<GpuiJsEngine> engines;
  return engines;
}

std::string& selection() {
  static std::string name;
  return name;
}

std::string joinNames(const std::vector<GpuiJsEngine>& engines) {
  std::string joined;
  for (const auto& engine : engines) {
    if (!joined.empty()) {
      joined += ", ";
    }
    joined += engine.info.name;
  }
  return joined;
}

[[noreturn]] void throwNoEngine() {
  throw std::runtime_error(
      "no JS engine installed; add @react-native-gpui/hermes (or another "
      "engine package) to the app's dependencies");
}

[[noreturn]] void throwUnknownEngine(
    const std::string& name,
    const std::vector<GpuiJsEngine>& engines) {
  throw std::runtime_error(
      "unknown JS engine '" + name +
      "'; registered engines: " + joinNames(engines));
}

[[noreturn]] void throwAmbiguousEngine(
    const std::vector<GpuiJsEngine>& engines) {
  throw std::runtime_error(
      "several JS engines are installed (" + joinNames(engines) +
      "); choose one with RN_GPUI_JS_ENGINE or DesktopAppConfig::js_engine");
}

const GpuiJsEngine* findEngine(
    const std::vector<GpuiJsEngine>& engines,
    std::string_view name) {
  for (const auto& engine : engines) {
    if (engine.info.name == name) {
      return &engine;
    }
  }
  return nullptr;
}

} // namespace

void registerJsEngine(GpuiJsEngine engine) {
  if (engine.info.name.empty()) {
    throw std::invalid_argument("a JS engine must report a name");
  }
  if (engine.makeRuntimeFactory == nullptr) {
    throw std::invalid_argument(
        "JS engine '" + engine.info.name + "' has no runtime factory");
  }
  std::lock_guard<std::mutex> lock(registryMutex());
  if (findEngine(registry(), engine.info.name) != nullptr) {
    throw std::invalid_argument(
        "duplicate JS engine '" + engine.info.name + "'");
  }
  registry().push_back(std::move(engine));
}

void selectJsEngine(std::string_view name) {
  std::lock_guard<std::mutex> lock(registryMutex());
  if (name.empty()) {
    selection().clear();
    return;
  }
  if (findEngine(registry(), name) == nullptr) {
    throwUnknownEngine(std::string(name), registry());
  }
  selection() = std::string(name);
}

const GpuiJsEngine& activeJsEngine() {
  std::lock_guard<std::mutex> lock(registryMutex());
  const auto& engines = registry();
  if (engines.empty()) {
    throwNoEngine();
  }
  if (!selection().empty()) {
    if (const auto* engine = findEngine(engines, selection())) {
      return *engine;
    }
    // The selection can only go stale if the registry changed after startup;
    // report it rather than silently running a different engine.
    throwUnknownEngine(selection(), engines);
  }
  if (engines.size() == 1) {
    return engines.front();
  }
  throwAmbiguousEngine(engines);
}

std::vector<GpuiJsEngineInfo> registeredJsEngines() {
  std::lock_guard<std::mutex> lock(registryMutex());
  std::vector<GpuiJsEngineInfo> infos;
  infos.reserve(registry().size());
  for (const auto& engine : registry()) {
    infos.push_back(engine.info);
  }
  return infos;
}

} // namespace rngpui
