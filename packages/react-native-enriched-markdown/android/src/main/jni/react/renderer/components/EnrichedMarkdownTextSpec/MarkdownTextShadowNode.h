#pragma once

#include "MarkdownTextMeasurementManager.h"
#include "MarkdownTextState.h"

#include <react/renderer/components/EnrichedMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/EnrichedMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {

JSI_EXPORT extern const char MarkdownTextComponentName[];

/*
 * `ShadowNode` for <EnrichedMarkdownText> component.
 */
class MarkdownTextShadowNode final
    : public ConcreteViewShadowNode<MarkdownTextComponentName, EnrichedMarkdownTextProps,
                                    EnrichedMarkdownTextEventEmitter, MarkdownTextState> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  MarkdownTextShadowNode(ShadowNode const &sourceShadowNode, ShadowNodeFragment const &fragment)
      : ConcreteViewShadowNode(sourceShadowNode, fragment) {
    forceHeightRecalculationCounter_ =
        static_cast<const MarkdownTextShadowNode &>(sourceShadowNode).forceHeightRecalculationCounter_;
    dirtyLayoutIfNeeded();
  }

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  // Associates a shared `MarkdownTextMeasurementManager` with the node.
  void setMeasurementsManager(const std::shared_ptr<MarkdownTextMeasurementManager> &measurementsManager);

  void dirtyLayoutIfNeeded();

  Size measureContent(const LayoutContext &layoutContext, const LayoutConstraints &layoutConstraints) const override;

protected:
  bool shouldNewRevisionDirtyMeasurement(const ShadowNode &sourceShadowNode,
                                         const ShadowNodeFragment &fragment) const override;

private:
  int forceHeightRecalculationCounter_{0};
  std::shared_ptr<MarkdownTextMeasurementManager> measurementsManager_;
};

} // namespace facebook::react
