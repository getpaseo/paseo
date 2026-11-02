#pragma once

#include <react/renderer/components/view/BaseViewProps.h>
#include <react/renderer/core/PropsMacros.h>
#include <react/renderer/core/propsConversions.h>

namespace facebook::react {
class HostPlatformViewProps : public BaseViewProps {
 public:
  HostPlatformViewProps() = default;
  HostPlatformViewProps(
      const PropsParserContext& context,
      const HostPlatformViewProps& sourceProps,
      const RawProps& rawProps)
      : BaseViewProps(context, sourceProps, rawProps),
        focusable(convertRawProp(
            context,
            rawProps,
            "focusable",
            sourceProps.focusable,
            false)),
        desktopDragRegion(convertRawProp(
            context,
            rawProps,
            "desktopDragRegion",
            sourceProps.desktopDragRegion,
            false)),
        // Either handler is enough to make the view a context-menu target. Fabric
        // turns a function prop into `true`, so a view with only the capture
        // handler used to get no listener at all.
        onContextMenu(
            convertRawProp(
                context,
                rawProps,
                "onContextMenu",
                sourceProps.onContextMenu,
                false) ||
            convertRawProp(
                context,
                rawProps,
                "onContextMenuCapture",
                false,
                false)) {}

  void setProp(
      const PropsParserContext& context,
      RawPropsPropNameHash hash,
      const char* propName,
      const RawValue& value) {
    BaseViewProps::setProp(context, hash, propName, value);
    static auto defaults = HostPlatformViewProps{};
    switch (hash) {
      RAW_SET_PROP_SWITCH_CASE_BASIC(focusable);
      RAW_SET_PROP_SWITCH_CASE_BASIC(desktopDragRegion);
      // There is one stored flag, so only `onContextMenu` gets a case here; a
      // second case would need a field that does not exist. An update to either
      // prop still re-parses through the constructor above, where the two are
      // OR'd, so a view that swaps `onContextMenu` for `onContextMenuCapture`
      // keeps its listener.
      RAW_SET_PROP_SWITCH_CASE_BASIC(onContextMenu);
    }
  }

  bool focusable{false};
  bool desktopDragRegion{false};
  /// True when the view has an `onContextMenu` handler (RN turns a function
  /// prop into this boolean marker).
  bool onContextMenu{false};
};

} // namespace facebook::react
