#pragma once

#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/debug/DebugStringConvertible.h>

namespace facebook::react {

extern const char NativeViewHostComponentName[];

class NativeViewHostProps final : public ViewProps {
 public:
  NativeViewHostProps() = default;
  NativeViewHostProps(
      const PropsParserContext& context,
      const NativeViewHostProps& sourceProps,
      const RawProps& rawProps);

  std::string viewName;
  std::string nativePropsJson{"{}"};

#ifdef RN_SERIALIZABLE_STATE
  ComponentName getDiffPropsImplementationTarget() const override;
  folly::dynamic getDiffProps(const Props* prevProps) const override;
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
  SharedDebugStringConvertibleList getDebugProps() const override;
#endif
};

using NativeViewHostShadowNode = ConcreteViewShadowNode<
    NativeViewHostComponentName,
    NativeViewHostProps,
    ViewEventEmitter>;
using NativeViewHostComponentDescriptor =
    ConcreteComponentDescriptor<NativeViewHostShadowNode>;

} // namespace facebook::react
