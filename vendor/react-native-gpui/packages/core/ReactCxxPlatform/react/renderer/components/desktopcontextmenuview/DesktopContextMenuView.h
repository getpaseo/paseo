#pragma once

#include <folly/dynamic.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/debug/DebugStringConvertible.h>

#include <string>

// Hand-written rather than generated: core has no component codegen, because
// autolink only runs it for dependencies and core is the runtime. This follows
// `windowcontrol/WindowControl.h`, core's other hand-registered component.
namespace facebook::react {

extern const char DesktopContextMenuViewComponentName[];

/// A view whose secondary click opens a menu from native.
///
/// `items` is the menu model itself — a recursive array that codegen cannot
/// describe, which is why the JS spec types it as `UnsafeMixed` and it arrives
/// here as `folly::dynamic`. The Rust renderer reads it as JSON from the props
/// reader, in the same shape `MenuItemSpec` uses everywhere else, so a menu
/// shown by this component and one shown by `ContextMenu.show` cannot differ.
class DesktopContextMenuViewProps final : public ViewProps {
 public:
  DesktopContextMenuViewProps() = default;
  DesktopContextMenuViewProps(
      const PropsParserContext& context,
      const DesktopContextMenuViewProps& sourceProps,
      const RawProps& rawProps);

  // Copy-init, not brace-init: `folly::dynamic` has an initializer-list
  // constructor, so braces here would build a one-element array holding an empty
  // array.
  folly::dynamic items = folly::dynamic::array();
  /// `default`, `native` or `custom`. `custom` is opened by JS, so the native
  /// renderer leaves it alone; `default` means whatever the app asked for,
  /// which this path can only serve as a native menu.
  std::string presentation{"default"};
  bool disabled{false};

#ifdef RN_SERIALIZABLE_STATE
  ComponentName getDiffPropsImplementationTarget() const override;
  folly::dynamic getDiffProps(const Props* prevProps) const override;
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
  SharedDebugStringConvertibleList getDebugProps() const override;
#endif
};

using DesktopContextMenuViewShadowNode = ConcreteViewShadowNode<
    DesktopContextMenuViewComponentName,
    DesktopContextMenuViewProps,
    ViewEventEmitter>;
using DesktopContextMenuViewComponentDescriptor =
    ConcreteComponentDescriptor<DesktopContextMenuViewShadowNode>;

} // namespace facebook::react
