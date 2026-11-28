#include "GpuiCppHostComponent.h"

#include "GpuiCppHostBridge.h"
#include "GpuiHostComponentsCpp.h"

#include <glog/logging.h>

#include <deque>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace rngpui {
namespace {
struct Declaration {
  uint32_t index;
  std::string name;
  bool nativeSurface;
};

struct Registry {
  std::mutex mutex;
  std::vector<Declaration> declarations;
  std::deque<std::string> names;
  std::vector<std::function<std::unique_ptr<extension::CppHostView>(int32_t)>>
      creators;
};

Registry& registry() {
  static Registry registry;
  return registry;
}

struct LiveView {
  std::unique_ptr<extension::CppHostView> view;
  std::shared_ptr<const facebook::react::Props> lastProps;
};

std::unordered_map<uint64_t, LiveView>& liveViews() {
  static std::unordered_map<uint64_t, LiveView> views;
  return views;
}

uint64_t& nextId() {
  static uint64_t id = 1;
  return id;
}

std::shared_ptr<const facebook::react::Props> propsOf(std::size_t handle) {
  if (handle == 0) {
    return nullptr;
  }
  return reinterpret_cast<const HostPropsHandle*>(handle)->props;
}

void markChanged(
    const facebook::react::Props&,
    const facebook::react::Props&,
    uint64_t* words) {
  words[0] |= 1;
}

bool noCommand(int32_t, const std::string&, const folly::dynamic&) {
  return false;
}
} // namespace

namespace extension {
void declareCppHostComponent(
    uint32_t index,
    const char* name,
    bool nativeSurface) {
  auto& reg = registry();
  std::lock_guard<std::mutex> lock(reg.mutex);
  reg.declarations.push_back({index, name, nativeSurface});
}

void registerCppHostComponent(CppHostComponent component) {
  auto& reg = registry();
  std::lock_guard<std::mutex> lock(reg.mutex);
  const Declaration* found = nullptr;
  for (const auto& declaration : reg.declarations) {
    if (declaration.name == component.name) {
      found = &declaration;
      break;
    }
  }
  if (found == nullptr) {
    LOG(ERROR) << "[host-component] " << component.name
               << " is a C++ host component but is not declared with cpp: true "
                  "under platforms.desktop.hostComponents; ignored";
    return;
  }
  reg.names.push_back(component.name);
  HostComponentEntry entry;
  entry.index = found->index;
  entry.name = reg.names.back().c_str();
  entry.handle = component.handle;
  entry.nativeSurface = found->nativeSurface;
  entry.provider = component.provider;
  entry.changed = &markChanged;
  entry.changeWords = 1;
  entry.command = &noCommand;
  if (reg.creators.size() <= found->index) {
    reg.creators.resize(found->index + 1);
  }
  reg.creators[found->index] = std::move(component.create);
  registerHostComponentEntry(entry);
}
} // namespace extension

uint64_t
rn_gpui_cpp_host_create(uint32_t index, int32_t tag, std::size_t props) {
  std::function<std::unique_ptr<extension::CppHostView>(int32_t)> create;
  {
    auto& reg = registry();
    std::lock_guard<std::mutex> lock(reg.mutex);
    if (index < reg.creators.size()) {
      create = reg.creators[index];
    }
  }
  if (!create) {
    LOG_FIRST_N(ERROR, 1)
        << "[host-component] no C++ implementation is registered for host "
           "component index "
        << index;
    return 0;
  }
  auto view = create(tag);
  if (!view) {
    return 0;
  }
  auto current = propsOf(props);
  view->update(current, nullptr);
  const uint64_t id = nextId()++;
  liveViews().emplace(id, LiveView{std::move(view), std::move(current)});
  return id;
}

void rn_gpui_cpp_host_update(uint64_t id, std::size_t props) {
  auto found = liveViews().find(id);
  if (found == liveViews().end()) {
    return;
  }
  auto current = propsOf(props);
  found->second.view->update(current, found->second.lastProps);
  found->second.lastProps = std::move(current);
}

uint64_t rn_gpui_cpp_host_create_view(
    uint64_t id,
    std::size_t windows_visual,
    bool wayland,
    uint32_t x11_window,
    std::size_t xcb_connection,
    std::size_t wayland_display,
    std::size_t wayland_surface,
    uint8_t& kind) {
  kind = 0;
  auto found = liveViews().find(id);
  if (found == liveViews().end()) {
    return 0;
  }
  extension::NativeViewParent parent;
  parent.windowsVisual = reinterpret_cast<void*>(windows_visual);
  parent.wayland = wayland;
  parent.x11Window = x11_window;
  parent.xcbConnection = reinterpret_cast<void*>(xcb_connection);
  parent.waylandDisplay = reinterpret_cast<void*>(wayland_display);
  parent.waylandSurface = reinterpret_cast<void*>(wayland_surface);
  const auto view = found->second.view->createNativeView(parent);
  switch (view.kind) {
    case extension::NativeView::Kind::NSView:
      kind = 1;
      return reinterpret_cast<uint64_t>(view.nsView);
    case extension::NativeView::Kind::X11Window:
      kind = 2;
      return view.x11Window;
    case extension::NativeView::Kind::Composited:
      break;
  }
  return 0;
}

void rn_gpui_cpp_host_destroy(uint64_t id) {
  auto found = liveViews().find(id);
  if (found == liveViews().end()) {
    return;
  }
  auto live = std::move(found->second);
  liveViews().erase(found);
  live.view->unmount();
}
} // namespace rngpui
