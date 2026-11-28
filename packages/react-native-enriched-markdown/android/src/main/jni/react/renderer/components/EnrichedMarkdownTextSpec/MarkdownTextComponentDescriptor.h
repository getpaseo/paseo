#pragma once

#include "MarkdownTextMeasurementManager.h"
#include "MarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {

class MarkdownTextComponentDescriptor final : public ConcreteComponentDescriptor<MarkdownTextShadowNode> {
public:
  MarkdownTextComponentDescriptor(const ComponentDescriptorParameters &parameters)
      : ConcreteComponentDescriptor(parameters),
        measurementsManager_(std::make_shared<MarkdownTextMeasurementManager>(contextContainer_)) {}

  void adopt(ShadowNode &shadowNode) const override {
    ConcreteComponentDescriptor::adopt(shadowNode);
    auto &markdownTextShadowNode = static_cast<MarkdownTextShadowNode &>(shadowNode);

    // MarkdownTextShadowNode uses MarkdownTextMeasurementManager
    // to provide measurements to Yoga.
    markdownTextShadowNode.setMeasurementsManager(measurementsManager_);
  }

private:
  const std::shared_ptr<MarkdownTextMeasurementManager> measurementsManager_;
};

} // namespace facebook::react
