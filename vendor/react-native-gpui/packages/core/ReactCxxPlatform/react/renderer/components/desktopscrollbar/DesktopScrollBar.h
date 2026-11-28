#pragma once

#include <folly/dynamic.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/debug/DebugStringConvertible.h>
#include <react/renderer/graphics/Color.h>

#include <string>

// Hand-written like `shortcutscope/ShortcutScope.h`: core has no component
// codegen. The component paints and lays out nothing. The scroll view that
// contains it reads these props and draws its own scrollbar from them, and the
// drag events go out on this node.
namespace facebook::react {

extern const char DesktopScrollBarComponentName[];

/// How the scrollbar of the nearest scroll view looks and behaves. A negative
/// number, an empty string or an unset color keeps the default.
class DesktopScrollBarProps final : public ViewProps {
 public:
  DesktopScrollBarProps() = default;
  DesktopScrollBarProps(
      const PropsParserContext& context,
      const DesktopScrollBarProps& sourceProps,
      const RawProps& rawProps);

  Float thickness{-1};
  Float minLength{-1};
  Float margin{-1};
  SharedColor color{};
  Float radius{-1};
  SharedColor trackColor{};
  /// `auto`, `always` or `hover`.
  std::string visibility{};
  Float autoHideDelay{-1};
  bool interactive{true};

#ifdef RN_SERIALIZABLE_STATE
  ComponentName getDiffPropsImplementationTarget() const override;
  folly::dynamic getDiffProps(const Props* prevProps) const override;
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
  SharedDebugStringConvertibleList getDebugProps() const override;
#endif
};

using DesktopScrollBarShadowNode = ConcreteViewShadowNode<
    DesktopScrollBarComponentName,
    DesktopScrollBarProps,
    ViewEventEmitter>;
using DesktopScrollBarComponentDescriptor =
    ConcreteComponentDescriptor<DesktopScrollBarShadowNode>;

} // namespace facebook::react
