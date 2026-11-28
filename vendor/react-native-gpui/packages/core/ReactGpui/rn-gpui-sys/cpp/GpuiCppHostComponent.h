#pragma once

#include <react/renderer/componentregistry/ComponentDescriptorProvider.h>
#include <react/renderer/core/Props.h>
#include <react/renderer/core/ShadowNode.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace rngpui::extension {

/// Where a native view is created: the composition surface core made for the
/// node.
struct NativeViewParent {
  /// Windows: the node's IDCompositionVisual, as IUnknown*. Null elsewhere.
  void* windowsVisual = nullptr;
  /// Linux: X11 (xcb) or Wayland. Unused on macOS.
  bool wayland = false;
  uint32_t x11Window = 0;
  void* xcbConnection = nullptr;
  void* waylandDisplay = nullptr;
  void* waylandSurface = nullptr;
};

/// The native view of a component, as `createNativeView` returns it.
struct NativeView {
  enum class Kind { Composited, NSView, X11Window };
  Kind kind = Kind::Composited;
  /// A +1 retained NSView*; core takes ownership.
  void* nsView = nullptr;
  /// A child window the view keeps owning.
  uint32_t x11Window = 0;
};

/// One mounted node of a C++ host component. Every method runs on the main
/// thread.
class CppHostView {
 public:
  virtual ~CppHostView() = default;
  /// The props changed. `oldProps` is null on the first call.
  virtual void update(
      const std::shared_ptr<const facebook::react::Props>& props,
      const std::shared_ptr<const facebook::react::Props>& oldProps) = 0;
  /// Once, when the node is first painted. Only for `nativeSurface`
  /// components.
  virtual NativeView createNativeView(const NativeViewParent& parent) {
    return {};
  }
  /// The node unmounts; called before destruction.
  virtual void unmount() {}
};

struct CppHostComponent {
  /// The Fabric component name, as `hostComponents` declares it.
  std::string name;
  /// `ShadowNode::Handle()` of the component's shadow node.
  facebook::react::ComponentHandle handle = 0;
  facebook::react::ComponentDescriptorProvider (*provider)() = nullptr;
  std::function<std::unique_ptr<CppHostView>(int32_t tag)> create;
};

/// Declares a `cpp: true` entry of `hostComponents`. Called by the autolink
/// generated code, before any module's init function runs.
void declareCppHostComponent(
    uint32_t index,
    const char* name,
    bool nativeSurface);

/// Registers the implementation of a declared component, matched by name. An
/// undeclared component, or one registered after the registry froze, is logged
/// and ignored.
void registerCppHostComponent(CppHostComponent component);

} // namespace rngpui::extension
