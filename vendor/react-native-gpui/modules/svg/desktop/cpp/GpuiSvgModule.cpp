#include "GpuiModules.h"
#include "MountBatchBuilder.h"

#include <react/renderer/components/rnsvg/Props.h>

#include <folly/json.h>
#include <string>
#include <vector>

namespace rngpui {
using namespace facebook::react;

namespace {
constexpr const char* kSvgComponents[] = {
    "RNSVGSvgView",
    "RNSVGCircle",
    "RNSVGEllipse",
    "RNSVGLine",
    "RNSVGPath",
    "RNSVGRect",
    "RNSVGGroup",
    "RNSVGDefs",
    "RNSVGClipPath",
    "RNSVGLinearGradient",
    "RNSVGRadialGradient",
    "RNSVGText",
    "RNSVGTSpan",
};

template <typename T>
folly::dynamic svgJsonValue(const T& value) {
  return value;
}

folly::dynamic svgJsonValue(const Float& value) {
  return value;
}
folly::dynamic svgJsonValue(const SharedColor& value) {
  return value ? folly::dynamic(argb(value)) : folly::dynamic(nullptr);
}
folly::dynamic svgJsonValue(const std::vector<std::string>& values) {
  folly::dynamic result = folly::dynamic::array();
  for (const auto& value : values)
    result.push_back(value);
  return result;
}
folly::dynamic svgJsonValue(const std::vector<Float>& values) {
  folly::dynamic result = folly::dynamic::array();
  for (auto value : values)
    result.push_back(value);
  return result;
}

template <typename T>
folly::dynamic svgPropsJson(const T& props) {
  folly::dynamic result = folly::dynamic::object();
#define RN_GPUI_COPY_SVG_PROP(name)       \
  if constexpr (requires { props.name; }) \
  result[#name] = svgJsonValue(props.name)
  RN_GPUI_COPY_SVG_PROP(name);
  RN_GPUI_COPY_SVG_PROP(d);
  RN_GPUI_COPY_SVG_PROP(x);
  RN_GPUI_COPY_SVG_PROP(y);
  RN_GPUI_COPY_SVG_PROP(x1);
  RN_GPUI_COPY_SVG_PROP(y1);
  RN_GPUI_COPY_SVG_PROP(x2);
  RN_GPUI_COPY_SVG_PROP(y2);
  RN_GPUI_COPY_SVG_PROP(cx);
  RN_GPUI_COPY_SVG_PROP(cy);
  RN_GPUI_COPY_SVG_PROP(r);
  RN_GPUI_COPY_SVG_PROP(rx);
  RN_GPUI_COPY_SVG_PROP(ry);
  RN_GPUI_COPY_SVG_PROP(width);
  RN_GPUI_COPY_SVG_PROP(height);
  RN_GPUI_COPY_SVG_PROP(vbWidth);
  RN_GPUI_COPY_SVG_PROP(vbHeight);
  RN_GPUI_COPY_SVG_PROP(minX);
  RN_GPUI_COPY_SVG_PROP(minY);
  RN_GPUI_COPY_SVG_PROP(align);
  RN_GPUI_COPY_SVG_PROP(meetOrSlice);
  RN_GPUI_COPY_SVG_PROP(opacity);
  RN_GPUI_COPY_SVG_PROP(color);
  RN_GPUI_COPY_SVG_PROP(propList);
  RN_GPUI_COPY_SVG_PROP(fill);
  RN_GPUI_COPY_SVG_PROP(fillOpacity);
  RN_GPUI_COPY_SVG_PROP(fillRule);
  RN_GPUI_COPY_SVG_PROP(stroke);
  RN_GPUI_COPY_SVG_PROP(strokeOpacity);
  RN_GPUI_COPY_SVG_PROP(strokeWidth);
  RN_GPUI_COPY_SVG_PROP(strokeLinecap);
  RN_GPUI_COPY_SVG_PROP(strokeLinejoin);
  RN_GPUI_COPY_SVG_PROP(strokeDasharray);
  RN_GPUI_COPY_SVG_PROP(strokeDashoffset);
  RN_GPUI_COPY_SVG_PROP(strokeMiterlimit);
  RN_GPUI_COPY_SVG_PROP(matrix);
  RN_GPUI_COPY_SVG_PROP(mask);
  RN_GPUI_COPY_SVG_PROP(clipPath);
  RN_GPUI_COPY_SVG_PROP(offset);
  RN_GPUI_COPY_SVG_PROP(stopColor);
  RN_GPUI_COPY_SVG_PROP(stopOpacity);
#undef RN_GPUI_COPY_SVG_PROP
  return result;
}

folly::dynamic svgPropsJson(const std::string& component, const Props& props) {
#define RN_GPUI_SVG_PROPS(tag, type)                    \
  if (component == tag) {                               \
    if (auto typed = dynamic_cast<const type*>(&props)) \
      return svgPropsJson(*typed);                      \
  }
  RN_GPUI_SVG_PROPS("RNSVGSvgView", RNSVGSvgViewProps)
  RN_GPUI_SVG_PROPS("RNSVGCircle", RNSVGCircleProps)
  RN_GPUI_SVG_PROPS("RNSVGEllipse", RNSVGEllipseProps)
  RN_GPUI_SVG_PROPS("RNSVGLine", RNSVGLineProps)
  RN_GPUI_SVG_PROPS("RNSVGPath", RNSVGPathProps)
  RN_GPUI_SVG_PROPS("RNSVGRect", RNSVGRectProps)
  RN_GPUI_SVG_PROPS("RNSVGGroup", RNSVGGroupProps)
  RN_GPUI_SVG_PROPS("RNSVGDefs", RNSVGDefsProps)
  RN_GPUI_SVG_PROPS("RNSVGClipPath", RNSVGClipPathProps)
  RN_GPUI_SVG_PROPS("RNSVGLinearGradient", RNSVGLinearGradientProps)
  RN_GPUI_SVG_PROPS("RNSVGRadialGradient", RNSVGRadialGradientProps)
  RN_GPUI_SVG_PROPS("RNSVGText", RNSVGTextProps)
  RN_GPUI_SVG_PROPS("RNSVGTSpan", RNSVGTSpanProps)
#undef RN_GPUI_SVG_PROPS
  return folly::dynamic::object();
}

} // namespace

void rn_gpui_install_svg_module() {
  for (const char* component : kSvgComponents) {
    registerComponentProps(
        component, [](const std::string& name, const ShadowView& view) {
          if (!view.props)
            return std::string("{}");
          return folly::toJson(svgPropsJson(name, *view.props));
        });
  }
}

} // namespace rngpui
