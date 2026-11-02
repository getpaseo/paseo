#include "DesktopContextMenuView.h"

#include <folly/json.h>
#include <react/renderer/core/graphicsConversions.h>
#include <react/renderer/core/propsConversions.h>
#include <react/renderer/debug/debugStringConvertibleUtils.h>

namespace facebook::react {

const char DesktopContextMenuViewComponentName[] = "DesktopContextMenuView";

DesktopContextMenuViewProps::DesktopContextMenuViewProps(
    const PropsParserContext& context,
    const DesktopContextMenuViewProps& sourceProps,
    const RawProps& rawProps)
    : ViewProps(context, sourceProps, rawProps),
      // `convertRawProp` reaches `folly::dynamic` through `RawValue`'s explicit
      // conversion, so the recursive model arrives as-is: no serialisation in
      // JS and no second shape to keep in step with `MenuItemSpec`.
      items(convertRawProp(
          context,
          rawProps,
          "items",
          sourceProps.items,
          folly::dynamic::array())),
      presentation(convertRawProp(
          context,
          rawProps,
          "presentation",
          sourceProps.presentation,
          std::string{"default"})),
      disabled(convertRawProp(
          context,
          rawProps,
          "disabled",
          sourceProps.disabled,
          false)) {}

#ifdef RN_SERIALIZABLE_STATE
ComponentName DesktopContextMenuViewProps::getDiffPropsImplementationTarget()
    const {
  return DesktopContextMenuViewComponentName;
}

folly::dynamic DesktopContextMenuViewProps::getDiffProps(
    const Props* prevProps) const {
  static const auto defaultProps = DesktopContextMenuViewProps();
  const auto* oldProps = prevProps == nullptr
      ? &defaultProps
      : static_cast<const DesktopContextMenuViewProps*>(prevProps);
  if (this == oldProps) {
    return folly::dynamic::object();
  }

  folly::dynamic result = ViewProps::getDiffProps(prevProps);
  // Compared as values, so a rebuilt array with the same entries is not a
  // change. That is what makes a memoised-but-reallocated `items` cheap.
  if (!(items == oldProps->items)) {
    result["items"] = items;
  }
  if (presentation != oldProps->presentation) {
    result["presentation"] = presentation;
  }
  if (disabled != oldProps->disabled) {
    result["disabled"] = disabled;
  }
  return result;
}
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
SharedDebugStringConvertibleList DesktopContextMenuViewProps::getDebugProps()
    const {
  return ViewProps::getDebugProps() +
      SharedDebugStringConvertibleList{
          debugStringConvertibleItem("items", folly::toJson(items)),
          debugStringConvertibleItem("presentation", presentation),
          debugStringConvertibleItem("disabled", disabled),
      };
}
#endif

} // namespace facebook::react
