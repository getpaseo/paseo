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
// `windowcontrol/WindowControl.h` and
// `desktopcontextmenuview/DesktopContextMenuView.h`, core's other
// hand-registered components.
//
// The component is a plain box with a name. Everything it means is decided
// natively: the Rust renderer turns `name` into a keymap context, and GPUI's
// keymap does the precedence. So the props here are one string, and the rest of
// the behaviour lives in `rn-gpui/src/builtins/shortcut_scope`.
namespace facebook::react {

extern const char ShortcutScopeComponentName[];

/// A named scope for keyboard shortcuts. Scopes nest; an inner scope's binding
/// outranks an outer one's.
class ShortcutScopeProps final : public ViewProps {
 public:
  ShortcutScopeProps() = default;
  ShortcutScopeProps(
      const PropsParserContext& context,
      const ShortcutScopeProps& sourceProps,
      const RawProps& rawProps);

  /// The name a `useShortcut`'s `when` refers to. Empty claims no context.
  std::string name{};

#ifdef RN_SERIALIZABLE_STATE
  ComponentName getDiffPropsImplementationTarget() const override;
  folly::dynamic getDiffProps(const Props* prevProps) const override;
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
  SharedDebugStringConvertibleList getDebugProps() const override;
#endif
};

using ShortcutScopeShadowNode = ConcreteViewShadowNode<
    ShortcutScopeComponentName,
    ShortcutScopeProps,
    ViewEventEmitter>;
using ShortcutScopeComponentDescriptor =
    ConcreteComponentDescriptor<ShortcutScopeShadowNode>;

} // namespace facebook::react
