#pragma once

#include <folly/dynamic.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/debug/DebugStringConvertible.h>

// Hand-written like `shortcutscope/ShortcutScope.h`: core has no component
// codegen. The component is a box whose content is a native tree: the nested
// components a second React reconciler describes, built natively without a
// Fabric node each. Its one prop names the tree.
namespace facebook::react {

extern const char NativeRootComponentName[];

class NativeRootProps final : public ViewProps {
 public:
  NativeRootProps() = default;
  NativeRootProps(
      const PropsParserContext& context,
      const NativeRootProps& sourceProps,
      const RawProps& rawProps);

  /// The id of the native tree this node shows. Zero shows nothing.
  int rootId{0};

  /// A size remembered from an earlier tree like this one, which a box takes
  /// until the runtime reports the real one. Negative for none.
  float hintHeight{-1};
  float hintWidth{-1};
  float hintMinWidth{-1};

#ifdef RN_SERIALIZABLE_STATE
  ComponentName getDiffPropsImplementationTarget() const override;
  folly::dynamic getDiffProps(const Props* prevProps) const override;
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
  SharedDebugStringConvertibleList getDebugProps() const override;
#endif
};

/// The size of the content the runtime laid out on the main thread. A box
/// without a height (or, with `fitWidth`, a width) of its own takes it as its
/// size.
struct NativeRootState {
  float height{0};
  bool hasHeight{false};
  float width{0};
  float minWidth{0};
  bool hasWidth{false};
};

#if defined(LOOM_RENDERER) && LOOM_RENDERER
// Loom lays the box out from its props; the runtime writes the measured size
// through Loom's native props lane instead of a state.
using NativeRootShadowNode =
    ConcreteViewShadowNode<NativeRootComponentName, NativeRootProps>;
using NativeRootComponentDescriptor =
    ConcreteComponentDescriptor<NativeRootShadowNode>;
#else
class NativeRootShadowNode final : public ConcreteViewShadowNode<
                                       NativeRootComponentName,
                                       NativeRootProps,
                                       ViewEventEmitter,
                                       NativeRootState> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  /// Applies the reported size to Yoga's style where the props leave the
  /// dimension open. Props set a style anew on every change, so this runs on
  /// every clone.
  void applyContentSize();
};

class NativeRootComponentDescriptor final
    : public ConcreteComponentDescriptor<NativeRootShadowNode> {
 public:
  using ConcreteComponentDescriptor::ConcreteComponentDescriptor;

  void adopt(ShadowNode& shadowNode) const override;
};
#endif

} // namespace facebook::react
