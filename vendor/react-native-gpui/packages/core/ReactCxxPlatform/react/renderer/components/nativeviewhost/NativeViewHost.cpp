#include "NativeViewHost.h"

#include <folly/json.h>
#include <react/renderer/core/graphicsConversions.h>
#include <react/renderer/core/propsConversions.h>
#include <react/renderer/debug/debugStringConvertibleUtils.h>

namespace facebook::react {

const char NativeViewHostComponentName[] = "NativeViewHost";

NativeViewHostProps::NativeViewHostProps(
    const PropsParserContext& context,
    const NativeViewHostProps& sourceProps,
    const RawProps& rawProps)
    : ViewProps(context, sourceProps, rawProps),
      viewName(convertRawProp(
          context,
          rawProps,
          "viewName",
          sourceProps.viewName,
          {std::string{}})),
      nativePropsJson(convertRawProp(
          context,
          rawProps,
          "nativePropsJson",
          sourceProps.nativePropsJson,
          {std::string{"{}"}})) {}

#ifdef RN_SERIALIZABLE_STATE
ComponentName NativeViewHostProps::getDiffPropsImplementationTarget() const {
  return "NativeViewHost";
}

folly::dynamic NativeViewHostProps::getDiffProps(const Props* prevProps) const {
  static const auto defaultProps = NativeViewHostProps();
  const auto* oldProps = prevProps == nullptr
      ? &defaultProps
      : static_cast<const NativeViewHostProps*>(prevProps);
  if (this == oldProps) return folly::dynamic::object();

  folly::dynamic result = ViewProps::getDiffProps(prevProps);
  if (viewName != oldProps->viewName) result["viewName"] = viewName;
  if (nativePropsJson != oldProps->nativePropsJson) {
    result["nativePropsJson"] = nativePropsJson;
  }
  return result;
}
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
SharedDebugStringConvertibleList NativeViewHostProps::getDebugProps() const {
  return ViewProps::getDebugProps() + SharedDebugStringConvertibleList{
      debugStringConvertibleItem("viewName", viewName),
      debugStringConvertibleItem("nativePropsJson", nativePropsJson),
  };
}
#endif

} // namespace facebook::react
