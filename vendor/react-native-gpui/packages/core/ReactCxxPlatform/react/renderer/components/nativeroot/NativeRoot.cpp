#include "NativeRoot.h"

#include <folly/json.h>
#include <react/renderer/core/graphicsConversions.h>
#include <react/renderer/core/propsConversions.h>
#include <react/renderer/debug/debugStringConvertibleUtils.h>

namespace facebook::react {

const char NativeRootComponentName[] = "DesktopNativeRoot";

NativeRootProps::NativeRootProps(
    const PropsParserContext& context,
    const NativeRootProps& sourceProps,
    const RawProps& rawProps)
    : ViewProps(context, sourceProps, rawProps),
      rootId(convertRawProp(
          context,
          rawProps,
          "rootId",
          sourceProps.rootId,
          0)),
      hintHeight(convertRawProp(
          context,
          rawProps,
          "hintHeight",
          sourceProps.hintHeight,
          -1.f)),
      hintWidth(convertRawProp(
          context,
          rawProps,
          "hintWidth",
          sourceProps.hintWidth,
          -1.f)),
      hintMinWidth(convertRawProp(
          context,
          rawProps,
          "hintMinWidth",
          sourceProps.hintMinWidth,
          -1.f)) {}

#ifdef RN_SERIALIZABLE_STATE
ComponentName NativeRootProps::getDiffPropsImplementationTarget() const {
  return NativeRootComponentName;
}

folly::dynamic NativeRootProps::getDiffProps(const Props* prevProps) const {
  static const auto defaultProps = NativeRootProps();
  const auto* oldProps = prevProps == nullptr
      ? &defaultProps
      : static_cast<const NativeRootProps*>(prevProps);
  if (this == oldProps) {
    return folly::dynamic::object();
  }

  folly::dynamic result = ViewProps::getDiffProps(prevProps);
  if (rootId != oldProps->rootId) {
    result["rootId"] = rootId;
  }
  if (hintHeight != oldProps->hintHeight) {
    result["hintHeight"] = hintHeight;
  }
  if (hintWidth != oldProps->hintWidth) {
    result["hintWidth"] = hintWidth;
  }
  if (hintMinWidth != oldProps->hintMinWidth) {
    result["hintMinWidth"] = hintMinWidth;
  }
  return result;
}
#endif

#if !(defined(LOOM_RENDERER) && LOOM_RENDERER)
void NativeRootShadowNode::applyContentSize() {
  const auto& data = getStateData();
  const auto& props = static_cast<const NativeRootProps&>(*getProps());
  const auto& base = props.yogaStyle;
  const auto height = data.hasHeight ? data.height : props.hintHeight;
  const auto width = data.hasWidth ? data.width : props.hintWidth;
  const auto minWidth = data.hasWidth ? data.minWidth : props.hintMinWidth;
  auto style = yogaNode_.style();
  const auto open = [&](yoga::Dimension axis) {
    const auto size = base.dimension(axis);
    return size.isUndefined() || size.isAuto();
  };
  if (height >= 0 && open(yoga::Dimension::Height)) {
    style.setDimension(
        yoga::Dimension::Height, yoga::StyleSizeLength::points(height));
  }
  if (width >= 0 && minWidth >= 0) {
    if (base.minDimension(yoga::Dimension::Width).isUndefined()) {
      style.setMinDimension(
          yoga::Dimension::Width, yoga::StyleSizeLength::points(minWidth));
    }
    if (base.maxDimension(yoga::Dimension::Width).isUndefined()) {
      style.setMaxDimension(
          yoga::Dimension::Width, yoga::StyleSizeLength::percent(100));
    }
    if (base.flexShrink().isUndefined()) {
      style.setFlexShrink(yoga::FloatOptional{1});
    }
    style.setDimension(
        yoga::Dimension::Width, yoga::StyleSizeLength::points(width));
  }
  if (style != yogaNode_.style()) {
    ensureUnsealed();
    yogaNode_.setStyle(style);
    yogaNode_.setDirty(true);
  }
}

void NativeRootComponentDescriptor::adopt(ShadowNode& shadowNode) const {
  static_cast<NativeRootShadowNode&>(shadowNode).applyContentSize();
  ConcreteComponentDescriptor::adopt(shadowNode);
}
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
SharedDebugStringConvertibleList NativeRootProps::getDebugProps() const {
  return ViewProps::getDebugProps() + SharedDebugStringConvertibleList{
      debugStringConvertibleItem("rootId", rootId),
      debugStringConvertibleItem("hintHeight", hintHeight),
      debugStringConvertibleItem("hintWidth", hintWidth),
      debugStringConvertibleItem("hintMinWidth", hintMinWidth),
  };
}
#endif

} // namespace facebook::react
