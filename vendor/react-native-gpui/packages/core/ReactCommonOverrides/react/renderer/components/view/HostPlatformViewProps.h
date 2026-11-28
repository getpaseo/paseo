#pragma once

#include <react/renderer/components/view/BaseViewProps.h>
#include <react/renderer/core/PropsMacros.h>
#include <react/renderer/core/propsConversions.h>
#include <functional>
#include <string>

namespace facebook::react {
class HostPlatformViewProps : public BaseViewProps {
 public:
  HostPlatformViewProps() = default;
  HostPlatformViewProps(
      const PropsParserContext& context,
      const HostPlatformViewProps& sourceProps,
      const RawProps& rawProps,
      const std::function<bool(const std::string&)>& filterObjectKeys = nullptr)
      : BaseViewProps(context, sourceProps, rawProps, filterObjectKeys),
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
        group(convertRawProp(
            context,
            rawProps,
            "group",
            sourceProps.group,
            std::string{})),
        hoverStyle(convertRawProp(
            context,
            rawProps,
            "hoverStyle",
            sourceProps.hoverStyle,
            std::string{})),
        activeStyle(convertRawProp(
            context,
            rawProps,
            "activeStyle",
            sourceProps.activeStyle,
            std::string{})),
        focusStyle(convertRawProp(
            context,
            rawProps,
            "focusStyle",
            sourceProps.focusStyle,
            std::string{})),
        focusVisibleStyle(convertRawProp(
            context,
            rawProps,
            "focusVisibleStyle",
            sourceProps.focusVisibleStyle,
            std::string{})),
        groupHoverStyle(convertRawProp(
            context,
            rawProps,
            "groupHoverStyle",
            sourceProps.groupHoverStyle,
            std::string{})),
        groupActiveStyle(convertRawProp(
            context,
            rawProps,
            "groupActiveStyle",
            sourceProps.groupActiveStyle,
            std::string{})),
        dragOverStyle(convertRawProp(
            context,
            rawProps,
            "dragOverStyle",
            sourceProps.dragOverStyle,
            std::string{})),
        acceptsFiles(convertRawProp(
            context,
            rawProps,
            "acceptsFiles",
            sourceProps.acceptsFiles,
            false)),
        tooltip(convertRawProp(
            context,
            rawProps,
            "tooltip",
            sourceProps.tooltip,
            std::string{})),
        draggable(convertRawProp(
            context,
            rawProps,
            "draggable",
            sourceProps.draggable,
            false)),
        droppable(convertRawProp(
            context,
            rawProps,
            "droppable",
            sourceProps.droppable,
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
                false)),
        onWheel(
            convertRawProp(
                context,
                rawProps,
                "onWheel",
                sourceProps.onWheel,
                false) ||
            convertRawProp(
                context,
                rawProps,
                "onWheelCapture",
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
      RAW_SET_PROP_SWITCH_CASE_BASIC(group);
      RAW_SET_PROP_SWITCH_CASE_BASIC(hoverStyle);
      RAW_SET_PROP_SWITCH_CASE_BASIC(activeStyle);
      RAW_SET_PROP_SWITCH_CASE_BASIC(focusStyle);
      RAW_SET_PROP_SWITCH_CASE_BASIC(focusVisibleStyle);
      RAW_SET_PROP_SWITCH_CASE_BASIC(groupHoverStyle);
      RAW_SET_PROP_SWITCH_CASE_BASIC(groupActiveStyle);
      RAW_SET_PROP_SWITCH_CASE_BASIC(dragOverStyle);
      RAW_SET_PROP_SWITCH_CASE_BASIC(acceptsFiles);
      RAW_SET_PROP_SWITCH_CASE_BASIC(tooltip);
      RAW_SET_PROP_SWITCH_CASE_BASIC(draggable);
      RAW_SET_PROP_SWITCH_CASE_BASIC(droppable);
      // There is one stored flag, so only `onContextMenu` gets a case here; a
      // second case would need a field that does not exist. An update to either
      // prop still re-parses through the constructor above, where the two are
      // OR'd, so a view that swaps `onContextMenu` for `onContextMenuCapture`
      // keeps its listener.
      RAW_SET_PROP_SWITCH_CASE_BASIC(onContextMenu);
      RAW_SET_PROP_SWITCH_CASE_BASIC(onWheel);
    }
  }

  bool focusable{false};
  bool desktopDragRegion{false};
  /// The state style props arrive as JSON text produced by the view config in
  /// JS; an empty string means the prop is not set.
  std::string group;
  std::string hoverStyle;
  std::string activeStyle;
  std::string focusStyle;
  std::string focusVisibleStyle;
  std::string groupHoverStyle;
  std::string groupActiveStyle;
  std::string dragOverStyle;
  bool acceptsFiles{false};
  std::string tooltip;
  bool draggable{false};
  bool droppable{false};
  /// True when the view has an `onContextMenu` handler (RN turns a function
  /// prop into this boolean marker).
  bool onContextMenu{false};
  /// True when the view has an `onWheel` or `onWheelCapture` handler.
  bool onWheel{false};
};

} // namespace facebook::react
