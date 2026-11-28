#pragma once
#include "MeasurementCache.h"
#include <ReactNativeEnrichedMarkdown/EnrichedMarkdownTextState.h>
#include <ReactNativeEnrichedMarkdown/EventEmitters.h>
#include <ReactNativeEnrichedMarkdown/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/LayoutConstraints.h>

namespace facebook::react {

JSI_EXPORT extern const char EnrichedMarkdownTextComponentName[];

/// ShadowNode implementing measureContent for automatic height calculation.
class EnrichedMarkdownTextShadowNode
    : public ConcreteViewShadowNode<EnrichedMarkdownTextComponentName, EnrichedMarkdownTextProps,
                                    EnrichedMarkdownTextEventEmitter, EnrichedMarkdownTextState> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  EnrichedMarkdownTextShadowNode(const ShadowNodeFragment &fragment, const ShadowNodeFamily::Shared &family,
                                 ShadowNodeTraits traits);

  EnrichedMarkdownTextShadowNode(const ShadowNode &sourceShadowNode, const ShadowNodeFragment &fragment);

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
