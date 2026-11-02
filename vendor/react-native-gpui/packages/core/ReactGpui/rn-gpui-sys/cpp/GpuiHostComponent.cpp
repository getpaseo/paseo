
#include "GpuiHostComponentsCpp.h"

#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/imagemanager/primitives.h>

#include <glog/logging.h>

#include <atomic>
#include <mutex>

namespace rngpui {
namespace {
/// What is registered while the app starts. Written by the generated files'
/// registration functions, then frozen into `FrozenTable` and never written
/// again.
struct PendingEntries {
  std::mutex mutex;
  std::vector<HostComponentEntry> entries;
};

PendingEntries& pending() {
  static PendingEntries pending;
  return pending;
}

/// Set by the first registration, before anything can ask for a component, so a
/// hot path skips everything below with one relaxed load.
std::atomic<bool>& anyFlag() {
  static std::atomic<bool> flag{false};
  return flag;
}

/// The frozen lookup: entries sorted by handle, found by binary search. A few
/// entries, one cache line or two, no hashing and no lock.
struct FrozenTable {
  std::vector<HostComponentEntry> entries;
  std::vector<std::pair<facebook::react::ComponentHandle, uint32_t>> byHandle;
};

std::atomic<uint64_t>& lookupCount() {
  static std::atomic<uint64_t> count{0};
  return count;
}

std::atomic<const FrozenTable*>& frozenTable() {
  static std::atomic<const FrozenTable*> table{nullptr};
  return table;
}
} // namespace

void registerHostComponentEntry(const HostComponentEntry& entry) {
  if (frozenTable().load(std::memory_order_acquire) != nullptr) {
    LOG(ERROR) << "[host-component] " << entry.name
               << " registered after the registry froze; ignored";
    return;
  }
  auto& reg = pending();
  std::lock_guard<std::mutex> lock(reg.mutex);
  if (reg.entries.size() <= entry.index) {
    reg.entries.resize(entry.index + 1);
  }
  reg.entries[entry.index] = entry;
  anyFlag().store(true, std::memory_order_release);
}

bool anyHostComponents() {
  return anyFlag().load(std::memory_order_relaxed);
}

uint64_t hostEntryLookups() {
  return lookupCount().load(std::memory_order_relaxed);
}

void resetHostEntryLookups() {
  lookupCount().store(0, std::memory_order_relaxed);
}

const HostComponentEntry* hostComponentEntry(
    facebook::react::ComponentHandle handle) {
  lookupCount().fetch_add(1, std::memory_order_relaxed);
  const FrozenTable* table = frozenTable().load(std::memory_order_acquire);
  if (table == nullptr) {
    return nullptr;
  }
  const auto& keys = table->byHandle;
  auto found = std::lower_bound(
      keys.begin(), keys.end(), handle, [](const auto& key, auto value) {
        return key.first < value;
      });
  if (found == keys.end() || found->first != handle) {
    return nullptr;
  }
  return &table->entries[found->second];
}

void registerHostComponentDescriptors(
    facebook::react::ComponentDescriptorProviderRegistry& registry) {
  if (frozenTable().load(std::memory_order_acquire) != nullptr) {
    return;
  }
  auto table = std::make_unique<FrozenTable>();
  {
    auto& reg = pending();
    std::lock_guard<std::mutex> lock(reg.mutex);
    table->entries = reg.entries;
  }
  for (uint32_t index = 0; index < table->entries.size(); ++index) {
    const auto& entry = table->entries[index];
    if (entry.provider == nullptr) {
      continue;
    }
    registry.add(entry.provider());
    table->byHandle.emplace_back(entry.handle, index);
  }
  std::sort(table->byHandle.begin(), table->byHandle.end());
  frozenTable().store(table.release(), std::memory_order_release);
}

void releaseHostPropsHandle(std::size_t handle) {
  delete reinterpret_cast<HostPropsHandle*>(handle);
}

void releaseHostEmitterHandle(std::size_t handle) {
  delete reinterpret_cast<HostEmitterHandle*>(handle);
}

void dispatchHostCommand(
    int32_t tag,
    uint32_t command,
    std::vector<HostCommandValue>&& args) {
  rust::Vec<HostCommandArg> converted;
  converted.reserve(args.size());
  for (auto& value : args) {
    HostCommandArg arg;
    arg.kind = static_cast<uint8_t>(value.kind);
    arg.number = value.number;
    arg.text = rust::String(value.text);
    for (double number : value.numbers) {
      arg.numbers.push_back(number);
    }
    for (const auto& text : value.texts) {
      arg.texts.push_back(rust::String(text));
    }
    converted.push_back(std::move(arg));
  }
  rn_gpui_on_host_command(tag, command, std::move(converted));
}
} // namespace rngpui

namespace {
using ImageSource = facebook::react::ImageSource;

RnGpuiStr borrow(const std::string& text) {
  return RnGpuiStr{reinterpret_cast<const uint8_t*>(text.data()), text.size()};
}
} // namespace

extern "C" {
RnGpuiStr rn_gpui_image_source_uri(const void* image) {
  return borrow(static_cast<const ImageSource*>(image)->uri);
}

RnGpuiStr rn_gpui_image_source_bundle(const void* image) {
  return borrow(static_cast<const ImageSource*>(image)->bundle);
}

float rn_gpui_image_source_scale(const void* image) {
  return static_cast<const ImageSource*>(image)->scale;
}

float rn_gpui_image_source_width(const void* image) {
  return static_cast<const ImageSource*>(image)->size.width;
}

float rn_gpui_image_source_height(const void* image) {
  return static_cast<const ImageSource*>(image)->size.height;
}

RnGpuiStr rn_gpui_image_source_body(const void* image) {
  return borrow(static_cast<const ImageSource*>(image)->body);
}

RnGpuiStr rn_gpui_image_source_method(const void* image) {
  return borrow(static_cast<const ImageSource*>(image)->method);
}
} // extern "C"
