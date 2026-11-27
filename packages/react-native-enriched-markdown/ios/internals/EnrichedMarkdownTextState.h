#pragma once
#include <memory>

namespace facebook::react {

/// Counter triggers layout recalculation, viewRef allows shadow node to access view for measurement.
class EnrichedMarkdownTextState {
public:
  EnrichedMarkdownTextState() = default;
  EnrichedMarkdownTextState(int counter, std::shared_ptr<void> ref) : counter_(counter), viewRef_(ref) {}

  int getHeightRecalculationCounter() const {
    return counter_;
  }
  std::shared_ptr<void> getComponentViewRef() const {
    return viewRef_;
  }

private:
  int counter_{0};
  std::shared_ptr<void> viewRef_{nullptr};
};

} // namespace facebook::react
