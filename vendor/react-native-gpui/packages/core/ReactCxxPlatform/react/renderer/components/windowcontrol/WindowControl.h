#pragma once

#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/debug/DebugStringConvertible.h>

// Hand-written rather than generated: core has no component codegen, because
// autolink only runs it for dependencies and core is the runtime. This follows
// `nativeviewhost/NativeViewHost.h`, core's other hand-registered component.
namespace facebook::react {

extern const char WindowControlComponentName[];

/// The action a caption button performs.
enum class WindowControlAction {
  Minimize,
  Maximize,
  Close,
};

class WindowControlProps final : public ViewProps {
 public:
  WindowControlProps() = default;
  WindowControlProps(
      const PropsParserContext& context,
      const WindowControlProps& sourceProps,
      const RawProps& rawProps);

  WindowControlAction action{WindowControlAction::Close};
  bool disabled{false};

#ifdef RN_SERIALIZABLE_STATE
  ComponentName getDiffPropsImplementationTarget() const override;
  folly::dynamic getDiffProps(const Props* prevProps) const override;
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
  SharedDebugStringConvertibleList getDebugProps() const override;
#endif
};

using WindowControlShadowNode = ConcreteViewShadowNode<
    WindowControlComponentName,
    WindowControlProps,
    ViewEventEmitter>;
using WindowControlComponentDescriptor =
    ConcreteComponentDescriptor<WindowControlShadowNode>;

} // namespace facebook::react
