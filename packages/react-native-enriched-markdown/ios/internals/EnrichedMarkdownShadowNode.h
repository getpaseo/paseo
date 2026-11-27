#pragma once
#include "MeasurementCache.h"
#include <ReactNativeEnrichedMarkdown/EnrichedMarkdownState.h>
#include <ReactNativeEnrichedMarkdown/EventEmitters.h>
#include <ReactNativeEnrichedMarkdown/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/LayoutConstraints.h>

namespace facebook::react {

JSI_EXPORT extern const char EnrichedMarkdownComponentName[];

class EnrichedMarkdownShadowNode : public ConcreteViewShadowNode<EnrichedMarkdownComponentName, EnrichedMarkdownProps,
                                                                 EnrichedMarkdownEventEmitter, EnrichedMarkdownState> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  EnrichedMarkdownShadowNode(const ShadowNodeFragment &fragment, const ShadowNodeFamily::Shared &family,
                             ShadowNodeTraits traits);

  EnrichedMarkdownShadowNode(const ShadowNode &sourceShadowNode, const ShadowNodeFragment &fragment);

  void dirtyLayoutIfNeeded();

  Size measureContent(const LayoutContext &layoutContext, const LayoutConstraints &layoutConstraints) const override;

  static ShadowNodeTraits BaseTraits()
  {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

private:
  int localHeightRecalculationCounter_{0};
  mutable int lastExactMeasurementCounter_{0};
  mutable CGSize lastExactMeasurementSize_{0, 0};
};

} // namespace facebook::react
