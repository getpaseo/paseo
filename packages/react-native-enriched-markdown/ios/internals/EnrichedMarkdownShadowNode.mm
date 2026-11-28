#import "EnrichedMarkdownShadowNode.h"
#import "ENRMViewFreeMeasurement.h"
#import "EnrichedMarkdown.h"
#import "ShadowMeasurementUtils.h"
#import <yoga/Yoga.h>

namespace facebook::react {

extern const char EnrichedMarkdownComponentName[] = "EnrichedMarkdown";

EnrichedMarkdownShadowNode::EnrichedMarkdownShadowNode(const ShadowNodeFragment &fragment,
                                                       const ShadowNodeFamily::Shared &family, ShadowNodeTraits traits)
    : ConcreteViewShadowNode(fragment, family, traits)
{
}

EnrichedMarkdownShadowNode::EnrichedMarkdownShadowNode(const ShadowNode &sourceShadowNode,
                                                       const ShadowNodeFragment &fragment)
    : ConcreteViewShadowNode(sourceShadowNode, fragment),
      localHeightRecalculationCounter_(
          static_cast<const EnrichedMarkdownShadowNode &>(sourceShadowNode).localHeightRecalculationCounter_),
      lastExactMeasurementCounter_(
          static_cast<const EnrichedMarkdownShadowNode &>(sourceShadowNode).lastExactMeasurementCounter_),
      lastExactMeasurementSize_(
          static_cast<const EnrichedMarkdownShadowNode &>(sourceShadowNode).lastExactMeasurementSize_)
{
  const auto &oldProps = *std::static_pointer_cast<const EnrichedMarkdownProps>(sourceShadowNode.getProps());
  const auto &newProps = *std::static_pointer_cast<const EnrichedMarkdownProps>(this->getProps());

  if (newProps.streamingAnimation && ENRMPropsNeedExactStreamingMeasurement(oldProps, newProps)) {
    lastExactMeasurementCounter_ = -1;
  }

  dirtyLayoutIfNeeded();
}

void EnrichedMarkdownShadowNode::dirtyLayoutIfNeeded()
{
  const auto state = this->getStateData();
  const int receivedCounter = state.getHeightRecalculationCounter();

  if (receivedCounter > localHeightRecalculationCounter_) {
    localHeightRecalculationCounter_ = receivedCounter;
    YGNodeMarkDirty(&yogaNode_);
  }
}

Size EnrichedMarkdownShadowNode::measureContent(const LayoutContext &layoutContext,
                                                const LayoutConstraints &layoutConstraints) const
{
  const auto propsHandle = std::static_pointer_cast<const EnrichedMarkdownProps>(this->getProps());
  const auto &typedProps = *propsHandle;
  const int receivedCounter = getStateData().getHeightRecalculationCounter();
  const EnrichedMarkdownProps *props = propsHandle.get();
  CGFloat pointScaleFactor = layoutContext.pointScaleFactor;
  NSWritingDirection resolvedLayoutDirection = layoutConstraints.layoutDirection == LayoutDirection::RightToLeft
                                                   ? NSWritingDirectionRightToLeft
                                                   : NSWritingDirectionLeftToRight;

  return ENRMMeasureMarkdownContent<EnrichedMarkdownProps, EnrichedMarkdown>(
      typedProps, getStateData().getComponentViewRef(), receivedCounter, lastExactMeasurementCounter_,
      lastExactMeasurementSize_, MarkdownFlavor::GitHub, layoutContext, layoutConstraints,
      ^(EnrichedMarkdown *view, CGFloat maxWidth, CGFloat fontScale) {
        return ENRMMeasureSegmentedMarkdownViewFree(*props, maxWidth, fontScale, pointScaleFactor,
                                                    resolvedLayoutDirection);
      });
}

} // namespace facebook::react
