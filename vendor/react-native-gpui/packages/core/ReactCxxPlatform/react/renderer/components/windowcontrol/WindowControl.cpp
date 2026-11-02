#include "WindowControl.h"

#include <folly/json.h>
#include <react/renderer/core/graphicsConversions.h>
#include <react/renderer/core/propsConversions.h>
#include <react/renderer/debug/debugStringConvertibleUtils.h>

namespace facebook::react {

const char WindowControlComponentName[] = "DesktopWindowControl";

namespace {

WindowControlAction parseAction(
    const PropsParserContext& context,
    const RawProps& rawProps,
    const std::string& fallback) {
  const std::string action = convertRawProp(
      context, rawProps, "action", fallback, std::string{"close"});
  if (action == "minimize") return WindowControlAction::Minimize;
  if (action == "maximize") return WindowControlAction::Maximize;
  return WindowControlAction::Close;
}

const char* actionName(WindowControlAction action) {
  switch (action) {
    case WindowControlAction::Minimize:
      return "minimize";
    case WindowControlAction::Maximize:
      return "maximize";
    default:
      return "close";
  }
}

} // namespace

WindowControlProps::WindowControlProps(
    const PropsParserContext& context,
    const WindowControlProps& sourceProps,
    const RawProps& rawProps)
    : ViewProps(context, sourceProps, rawProps),
      action(parseAction(context, rawProps, actionName(sourceProps.action))),
      disabled(convertRawProp(
          context, rawProps, "disabled", sourceProps.disabled, false)) {}

#ifdef RN_SERIALIZABLE_STATE
ComponentName WindowControlProps::getDiffPropsImplementationTarget() const {
  return "DesktopWindowControl";
}

folly::dynamic WindowControlProps::getDiffProps(const Props* prevProps) const {
  static const auto defaultProps = WindowControlProps();
  const auto* oldProps = prevProps == nullptr
      ? &defaultProps
      : static_cast<const WindowControlProps*>(prevProps);
  if (this == oldProps) return folly::dynamic::object();

  folly::dynamic result = ViewProps::getDiffProps(prevProps);
  if (action != oldProps->action) result["action"] = actionName(action);
  if (disabled != oldProps->disabled) result["disabled"] = disabled;
  return result;
}
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
SharedDebugStringConvertibleList WindowControlProps::getDebugProps() const {
  return ViewProps::getDebugProps() + SharedDebugStringConvertibleList{
      debugStringConvertibleItem("action", std::string(actionName(action))),
      debugStringConvertibleItem("disabled", disabled),
  };
}
#endif

} // namespace facebook::react
