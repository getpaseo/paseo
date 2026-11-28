#pragma once

#include <react/renderer/components/FBReactNativeSpec/EventEmitters.h>
#include <react/renderer/components/FBReactNativeSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

// `Switch` is measured natively, as on iOS (`AppleSwitchShadowNode`): React
// Native's JS gives it no width or height.
namespace facebook::react {

extern const char DesktopSwitchComponentName[];

class DesktopSwitchShadowNode final : public ConcreteViewShadowNode<
                                          DesktopSwitchComponentName,
                                          SwitchProps,
                                          SwitchEventEmitter> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;
};

using DesktopSwitchComponentDescriptor =
    ConcreteComponentDescriptor<DesktopSwitchShadowNode>;

} // namespace facebook::react
