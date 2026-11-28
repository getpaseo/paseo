#include "MarkdownContainerShadowNode.h"

#include <react/renderer/core/LayoutContext.h>

namespace facebook::react {

extern const char MarkdownContainerComponentName[] = "EnrichedMarkdown";

void MarkdownContainerShadowNode::setMeasurementsManager(
    const std::shared_ptr<MarkdownContainerMeasurementManager> &measurementsManager) {
  ensureUnsealed();
  measurementsManager_ = measurementsManager;
}

void MarkdownContainerShadowNode::dirtyLayoutIfNeeded() {
  const auto state = this->getStateData();
  const auto counter = state.getForceHeightRecalculationCounter();

  if (forceHeightRecalculationCounter_ != counter) {
    forceHeightRecalculationCounter_ = counter;
    dirtyLayout();
  }
}

// Only new props change the rendered markdown. When a parent is cloned, React Native's adoptYogaChild
// re-clones its children without new props, and dirtying those clones re-measures every settled message
// whenever the list above grows.
bool MarkdownContainerShadowNode::shouldNewRevisionDirtyMeasurement(const ShadowNode & /*sourceShadowNode*/,
                                                                    const ShadowNodeFragment &fragment) const {
  return fragment.props != nullptr;
}

Size MarkdownContainerShadowNode::measureContent(const LayoutContext &layoutContext,
                                                 const LayoutConstraints &layoutConstraints) const {
  return measurementsManager_->measure(getSurfaceId(), getTag(), getConcreteProps(), layoutConstraints);
}

} // namespace facebook::react
