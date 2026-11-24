#pragma once
#include "EnrichedMarkdownTextShadowNode.h"
#include <react/debug/react_native_assert.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {

class EnrichedMarkdownTextComponentDescriptor final
    : public ConcreteComponentDescriptor<EnrichedMarkdownTextShadowNode> {
public:
  using ConcreteComponentDescriptor::ConcreteComponentDescriptor;

  void adopt(ShadowNode &shadowNode) const override {
    react_native_assert(dynamic_cast<EnrichedMarkdownTextShadowNode *>(&shadowNode));
    ConcreteComponentDescriptor::adopt(shadowNode);
  }
};

} // namespace facebook::react
