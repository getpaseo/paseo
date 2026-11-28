#pragma once

#include "GpuiMarkdownBridge.h"

#include <react/renderer/components/EnrichedMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/EnrichedMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/LayoutConstraints.h>
#include <react/renderer/core/LayoutContext.h>

namespace facebook::react {

JSI_EXPORT extern const char EnrichedMarkdownComponentName[];
JSI_EXPORT extern const char EnrichedMarkdownTextComponentName[];

template <const char* ComponentName, typename PropsT, typename EventEmitterT, bool IsContainer>
class EnrichedMarkdownConcreteShadowNode final
    : public ConcreteViewShadowNode<ComponentName, PropsT, EventEmitterT> {
public:
  using ConcreteViewShadowNode<ComponentName, PropsT, EventEmitterT>::ConcreteViewShadowNode;

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode<ComponentName, PropsT, EventEmitterT>::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  Size measureContent(
      const LayoutContext& /*layoutContext*/,
      const LayoutConstraints& layoutConstraints) const override {
    float maxWidth = layoutConstraints.maximumSize.width;
    float maxHeight = layoutConstraints.maximumSize.height;
    return rngpui::markdown::measureMarkdown(
        this->getConcreteProps(), IsContainer, maxWidth, maxHeight);
  }

protected:
  bool shouldNewRevisionDirtyMeasurement(
      const ShadowNode& /*sourceShadowNode*/,
      const ShadowNodeFragment& fragment) const override {
    return fragment.props != nullptr;
  }
};

using EnrichedMarkdownShadowNode = EnrichedMarkdownConcreteShadowNode<
    EnrichedMarkdownComponentName,
    EnrichedMarkdownProps,
    EnrichedMarkdownEventEmitter,
    true>;

using EnrichedMarkdownTextShadowNode = EnrichedMarkdownConcreteShadowNode<
    EnrichedMarkdownTextComponentName,
    EnrichedMarkdownTextProps,
    EnrichedMarkdownTextEventEmitter,
    false>;

} // namespace facebook::react
