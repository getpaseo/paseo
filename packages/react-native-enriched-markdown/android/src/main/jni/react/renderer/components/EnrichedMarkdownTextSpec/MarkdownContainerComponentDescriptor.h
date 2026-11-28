#pragma once

#include "MarkdownContainerMeasurementManager.h"
#include "MarkdownContainerShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {

class MarkdownContainerComponentDescriptor final : public ConcreteComponentDescriptor<MarkdownContainerShadowNode> {
public:
  MarkdownContainerComponentDescriptor(const ComponentDescriptorParameters &parameters)
      : ConcreteComponentDescriptor(parameters),
        measurementsManager_(std::make_shared<MarkdownContainerMeasurementManager>(contextContainer_)) {}

  void adopt(ShadowNode &shadowNode) const override {
    ConcreteComponentDescriptor::adopt(shadowNode);
    auto &containerShadowNode = static_cast<MarkdownContainerShadowNode &>(shadowNode);
    containerShadowNode.setMeasurementsManager(measurementsManager_);
  }

private:
  const std::shared_ptr<MarkdownContainerMeasurementManager> measurementsManager_;
};

} // namespace facebook::react
