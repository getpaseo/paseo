#include "ShortcutScope.h"

#include <folly/json.h>
#include <react/renderer/core/graphicsConversions.h>
#include <react/renderer/core/propsConversions.h>
#include <react/renderer/debug/debugStringConvertibleUtils.h>

namespace facebook::react {

const char ShortcutScopeComponentName[] = "DesktopShortcutScope";

ShortcutScopeProps::ShortcutScopeProps(
    const PropsParserContext& context,
    const ShortcutScopeProps& sourceProps,
    const RawProps& rawProps)
    : ViewProps(context, sourceProps, rawProps),
      name(convertRawProp(
          context,
          rawProps,
          "name",
          sourceProps.name,
          std::string{})) {}

#ifdef RN_SERIALIZABLE_STATE
ComponentName ShortcutScopeProps::getDiffPropsImplementationTarget() const {
  return ShortcutScopeComponentName;
}

folly::dynamic ShortcutScopeProps::getDiffProps(const Props* prevProps) const {
  static const auto defaultProps = ShortcutScopeProps();
  const auto* oldProps = prevProps == nullptr
      ? &defaultProps
      : static_cast<const ShortcutScopeProps*>(prevProps);
  if (this == oldProps) {
    return folly::dynamic::object();
  }

  folly::dynamic result = ViewProps::getDiffProps(prevProps);
  // A renamed scope is a different scope: every shortcut registered with
  // `when: <old name>` stops matching, so the rename has to reach the renderer.
  if (name != oldProps->name) {
    result["name"] = name;
  }
  return result;
}
#endif

#if RN_DEBUG_STRING_CONVERTIBLE
SharedDebugStringConvertibleList ShortcutScopeProps::getDebugProps() const {
  return ViewProps::getDebugProps() + SharedDebugStringConvertibleList{
      debugStringConvertibleItem("name", name),
  };
}
#endif

} // namespace facebook::react
