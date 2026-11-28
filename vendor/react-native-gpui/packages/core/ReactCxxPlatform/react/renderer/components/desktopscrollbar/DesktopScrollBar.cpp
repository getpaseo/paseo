#include "DesktopScrollBar.h"

#include <react/renderer/core/graphicsConversions.h>
#include <react/renderer/core/propsConversions.h>
#include <react/renderer/debug/debugStringConvertibleUtils.h>

namespace facebook::react {

const char DesktopScrollBarComponentName[] = "DesktopScrollBar";

DesktopScrollBarProps::DesktopScrollBarProps(
    const PropsParserContext& context,
    const DesktopScrollBarProps& sourceProps,
    const RawProps& rawProps)
    : ViewProps(context, sourceProps, rawProps),
      thickness(convertRawProp(
          context,
          rawProps,
          "thickness",
          sourceProps.thickness,
          Float{-1})),
      minLength(convertRawProp(
          context,
          rawProps,
          "minLength",
          sourceProps.minLength,
          Float{-1})),
      margin(convertRawProp(
          context,
          rawProps,
          "margin",
          sourceProps.margin,
          Float{-1})),
      color(convertRawProp(
          context,
          rawProps,
          "color",
          sourceProps.color,
          SharedColor{})),
      radius(convertRawProp(
          context,
          rawProps,
          "radius",
          sourceProps.radius,
          Float{-1})),
      trackColor(convertRawProp(
          context,
          rawProps,
          "trackColor",
          sourceProps.trackColor,
          SharedColor{})),
      visibility(convertRawProp(
          context,
          rawProps,
          "visibility",
          sourceProps.visibility,
          std::string{})),
      autoHideDelay(convertRawProp(
          context,
          rawProps,
          "autoHideDelay",
          sourceProps.autoHideDelay,
          Float{-1})),
      interactive(convertRawProp(
          context,
          rawProps,
          "interactive",
          sourceProps.interactive,
          true)) {}

#ifdef RN_SERIALIZABLE_STATE
ComponentName DesktopScrollBarProps::getDiffPropsImplementationTarget() const {
  return DesktopScrollBarComponentName;
}

folly::dynamic DesktopScrollBarProps::getDiffProps(
    const Props* prevProps) const {
  static const auto defaultProps = DesktopScrollBarProps();
  const auto* oldProps = prevProps == nullptr
      ? &defaultProps
      : static_cast<const DesktopScrollBarProps*>(prevProps);
  if (this == oldProps) {
    return folly::dynamic::object();
  }

  folly::dynamic result = ViewProps::getDiffProps(prevProps);
  if (thickness != oldProps->thickness) {
    result["thickness"] = thickness;
  }
  if (minLength != oldProps->minLength) {
    result["minLength"] = minLength;
  }
  if (margin != oldProps->margin) {
    result["margin"] = margin;
  }
  if (color != oldProps->color) {
    result["color"] = *color;
  }
  if (radius != oldProps->radius) {
    result["radius"] = radius;
  }
  if (trackColor != oldProps->trackColor) {
    result["trackColor"] = *trackColor;
  }
  if (visibility != oldProps->visibility) {
    result["visibility"] = visibility;
  }
  if (autoHideDelay != oldProps->autoHideDelay) {
    result["autoHideDelay"] = autoHideDelay;
  }
  if (interactive != oldProps->interactive) {
    result["interactive"] = interactive;
  }
  return result;
}
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
SharedDebugStringConvertibleList DesktopScrollBarProps::getDebugProps() const {
  return ViewProps::getDebugProps() + SharedDebugStringConvertibleList{
      debugStringConvertibleItem("thickness", thickness),
      debugStringConvertibleItem("visibility", visibility),
      debugStringConvertibleItem("interactive", interactive),
  };
}
#endif

} // namespace facebook::react
