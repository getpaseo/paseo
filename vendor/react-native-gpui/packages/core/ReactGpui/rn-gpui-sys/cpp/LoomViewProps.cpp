#if LOOM_RENDERER

#include "LoomViewProps.h"

#include "MountBatchBuilder.h"

#include <react/renderer/components/view/BackgroundImagePropsConversions.h>
#include <react/renderer/components/view/BaseViewProps.h>
#include <react/renderer/components/view/BoxShadowPropsConversions.h>
#include <react/renderer/components/view/FilterPropsConversions.h>
#include <react/renderer/components/view/accessibilityPropsConversions.h>
#include <react/renderer/components/view/conversions.h>
#include <react/renderer/core/RawValue.h>
#include <react/renderer/core/graphicsConversions.h>
#include <react/renderer/core/propsConversions.h>

#include <glog/logging.h>

#include <optional>
#include <string_view>
#include <unordered_map>

namespace rngpui {

using namespace facebook::react;
namespace yoga = facebook::yoga;

namespace {

struct ParseState {
  const PropsParserContext& context;
  ViewPropsFlat& view;
  LoomViewFlags& flags;
  std::unique_ptr<LoomViewDeps>& deps;

  CascadedBorderColors colors;
  CascadedBorderStyles styles;
  CascadedBorderRadii radii;
  CascadedBorderWidths widths;
  std::vector<BackgroundImage> backgroundImage;
  std::vector<BackgroundSize> backgroundSize;
  std::vector<BackgroundPosition> backgroundPosition;
  std::vector<BackgroundRepeat> backgroundRepeat;
  std::optional<AccessibilityState> accessibilityState;
  AccessibilityValue accessibilityValue;
  const folly::dynamic* accessibilityRole{nullptr};
  const folly::dynamic* role{nullptr};
  bool contextMenu{false};
  bool contextMenuCapture{false};
  bool wheel{false};
  bool wheelCapture{false};

  LoomViewDeps& ensureDeps() {
    if (!deps) {
      deps = std::make_unique<LoomViewDeps>();
    }
    return *deps;
  }
};

using Handler = void (*)(ParseState&, const folly::dynamic&);

template <class T>
bool convert(ParseState& state, const folly::dynamic& value, T& out) {
  if (value.isNull()) {
    return false;
  }
  try {
    fromRawValue(state.context, RawValue(value), out);
    return true;
  } catch (const std::exception& error) {
    LOG(ERROR) << "Loom: cannot convert a view prop: " << error.what();
    return false;
  }
}

template <class T>
T converted(ParseState& state, const folly::dynamic& value, T fallback = {}) {
  T result = fallback;
  if (!convert(state, value, result)) {
    return fallback;
  }
  return result;
}

void setOpacity(ParseState& state, const folly::dynamic& value) {
  state.view.opacity = converted<Float>(state, value, 1.f);
}

void setBackgroundColor(ParseState& state, const folly::dynamic& value) {
  state.view.background_color =
      argb(converted<SharedColor>(state, value, SharedColor{}));
}

void setBackgroundImage(ParseState& state, const folly::dynamic& value) {
  state.backgroundImage =
      converted<std::vector<BackgroundImage>>(state, value, {});
}

void setBackgroundSize(ParseState& state, const folly::dynamic& value) {
  state.backgroundSize =
      converted<std::vector<BackgroundSize>>(state, value, {});
}

void setBackgroundPosition(ParseState& state, const folly::dynamic& value) {
  state.backgroundPosition =
      converted<std::vector<BackgroundPosition>>(state, value, {});
}

void setBackgroundRepeat(ParseState& state, const folly::dynamic& value) {
  state.backgroundRepeat =
      converted<std::vector<BackgroundRepeat>>(state, value, {});
}

void setBoxShadow(ParseState& state, const folly::dynamic& value) {
  for (const auto& shadow :
       converted<std::vector<BoxShadow>>(state, value, {})) {
    state.view.shadows.push_back(
        {shadow.offsetX,
         shadow.offsetY,
         shadow.blurRadius,
         shadow.spreadDistance,
         argb(shadow.color),
         shadow.inset});
  }
}

void setFilter(ParseState& state, const folly::dynamic& value) {
  auto json =
      filterJson(converted<std::vector<FilterFunction>>(state, value, {}));
  if (!json.empty()) {
    state.view.filter_json = rust::String(json);
  }
}

void setMixBlendMode(ParseState& state, const folly::dynamic& value) {
  state.view.mix_blend_mode = static_cast<uint8_t>(
      converted<BlendMode>(state, value, BlendMode::Normal));
}

void setIsolation(ParseState& state, const folly::dynamic& value) {
  state.view.isolate =
      converted<Isolation>(state, value, Isolation::Auto) == Isolation::Isolate;
}

void setHitSlop(ParseState& state, const folly::dynamic& value) {
  const auto slop = converted<EdgeInsets>(state, value, {});
  state.view.hit_slop = {slop.left, slop.top, slop.right, slop.bottom};
}

void setBackfaceVisibility(ParseState& state, const folly::dynamic& value) {
  state.view.backface_hidden =
      converted<BackfaceVisibility>(state, value, BackfaceVisibility::Auto) ==
      BackfaceVisibility::Hidden;
}

void setOutlineColor(ParseState& state, const folly::dynamic& value) {
  state.view.outline_color =
      argb(converted<SharedColor>(state, value, SharedColor{}));
}

void setOutlineWidth(ParseState& state, const folly::dynamic& value) {
  state.view.outline_width = converted<Float>(state, value, 0.f);
}

void setOutlineOffset(ParseState& state, const folly::dynamic& value) {
  state.view.outline_offset = converted<Float>(state, value, 0.f);
}

void setOutlineStyle(ParseState& state, const folly::dynamic& value) {
  state.view.outline_style = static_cast<uint8_t>(
      converted<OutlineStyle>(state, value, OutlineStyle::Solid));
}

void setOverflow(ParseState& state, const folly::dynamic& value) {
  state.view.overflow_hidden =
      converted<yoga::Overflow>(state, value, yoga::Overflow::Visible) !=
      yoga::Overflow::Visible;
}

void setPointerEvents(ParseState& state, const folly::dynamic& value) {
  state.view.pointer_events = static_cast<uint8_t>(
      converted<PointerEventsMode>(state, value, PointerEventsMode::Auto));
}

void setCursor(ParseState& state, const folly::dynamic& value) {
  state.view.cursor =
      static_cast<uint8_t>(converted<Cursor>(state, value, Cursor::Auto));
}

void setTransform(ParseState& state, const folly::dynamic& value) {
  auto transform = converted<Transform>(state, value, {});
  if (!transform.operations.empty()) {
    state.ensureDeps().transform = std::move(transform);
  }
}

void setTransformOrigin(ParseState& state, const folly::dynamic& value) {
  const auto origin = converted<TransformOrigin>(state, value, {});
  if (origin.isSet()) {
    state.ensureDeps().transformOrigin = origin;
  }
}

template <auto Member>
void setBorderColor(ParseState& state, const folly::dynamic& value) {
  SharedColor color;
  (state.colors.*Member) = convert(state, value, color)
      ? std::optional<SharedColor>(color)
      : std::nullopt;
}

template <auto Member>
void setBorderStyle(ParseState& state, const folly::dynamic& value) {
  BorderStyle style{};
  (state.styles.*Member) = convert(state, value, style)
      ? std::optional<BorderStyle>(style)
      : std::nullopt;
}

template <auto Member>
void setBorderRadius(ParseState& state, const folly::dynamic& value) {
  ValueUnit unit;
  (state.radii.*Member) = convert(state, value, unit)
      ? std::optional<ValueUnit>(unit)
      : std::nullopt;
}

template <auto Member>
void setBorderWidth(ParseState& state, const folly::dynamic& value) {
  yoga::Style::Length length;
  (state.widths.*Member) = convert(state, value, length)
      ? optionalFloatFromYogaValue(length)
      : std::nullopt;
}

void setBool(bool& field, ParseState& state, const folly::dynamic& value) {
  field = converted<bool>(state, value, false);
}

void setString(
    rust::String& field,
    ParseState& state,
    const folly::dynamic& value) {
  auto text = converted<std::string>(state, value, std::string{});
  if (!text.empty()) {
    field = rust::String(text);
  }
}

#define BOOL_FIELD(handler, field)                               \
  void handler(ParseState& state, const folly::dynamic& value) { \
    setBool(state.view.field, state, value);                     \
  }
#define STRING_FIELD(handler, field)                             \
  void handler(ParseState& state, const folly::dynamic& value) { \
    setString(state.view.field, state, value);                   \
  }

BOOL_FIELD(setAccessible, accessible)
BOOL_FIELD(setAccessibilityViewIsModal, accessibility_modal)
BOOL_FIELD(setAccessibilityElementsHidden, accessibility_hidden)
BOOL_FIELD(
    setAccessibilityIgnoresInvertColors,
    accessibility_ignores_invert_colors)
BOOL_FIELD(
    setAccessibilityShowsLargeContent,
    accessibility_large_content_enabled)
BOOL_FIELD(setOnAccessibilityTap, accessibility_has_tap_listener)
BOOL_FIELD(setOnAccessibilityMagicTap, accessibility_has_magic_tap_listener)
BOOL_FIELD(setOnAccessibilityEscape, accessibility_has_escape_listener)
BOOL_FIELD(setOnAccessibilityAction, accessibility_has_action_listener)
BOOL_FIELD(setOnLayout, on_layout)
BOOL_FIELD(setFocusable, focusable)
BOOL_FIELD(setDesktopDragRegion, desktop_drag_region)
BOOL_FIELD(setAcceptsFiles, accepts_files)
BOOL_FIELD(setDraggable, draggable)
BOOL_FIELD(setDroppable, droppable)
STRING_FIELD(setTestId, test_id)
STRING_FIELD(setNativeId, accessibility_native_id)
STRING_FIELD(setAccessibilityLabel, accessibility_label)
STRING_FIELD(setAccessibilityHint, accessibility_hint)
STRING_FIELD(setAccessibilityLanguage, accessibility_language)
STRING_FIELD(
    setAccessibilityLargeContentTitle,
    accessibility_large_content_title)
STRING_FIELD(setGroup, group)
STRING_FIELD(setHoverStyle, hover_style)
STRING_FIELD(setActiveStyle, active_style)
STRING_FIELD(setFocusStyle, focus_style)
STRING_FIELD(setFocusVisibleStyle, focus_visible_style)
STRING_FIELD(setGroupHoverStyle, group_hover_style)
STRING_FIELD(setGroupActiveStyle, group_active_style)
STRING_FIELD(setDragOverStyle, drag_over_style)
STRING_FIELD(setTooltip, tooltip)

void setAccessibilityRespondsToInteraction(
    ParseState& state,
    const folly::dynamic& value) {
  state.view.accessibility_responds_to_interaction =
      converted<bool>(state, value, true);
}

void setOnContextMenu(ParseState& state, const folly::dynamic& value) {
  state.contextMenu = converted<bool>(state, value, false);
}

void setOnContextMenuCapture(ParseState& state, const folly::dynamic& value) {
  state.contextMenuCapture = converted<bool>(state, value, false);
}

void setOnWheel(ParseState& state, const folly::dynamic& value) {
  state.wheel = converted<bool>(state, value, false);
}

void setOnWheelCapture(ParseState& state, const folly::dynamic& value) {
  state.wheelCapture = converted<bool>(state, value, false);
}

void setAccessibilityState(ParseState& state, const folly::dynamic& value) {
  AccessibilityState parsed;
  state.accessibilityState = convert(state, value, parsed)
      ? std::optional<AccessibilityState>(parsed)
      : std::nullopt;
}

void setAccessibilityValue(ParseState& state, const folly::dynamic& value) {
  state.accessibilityValue = converted<AccessibilityValue>(state, value, {});
}

void setAccessibilityActions(ParseState& state, const folly::dynamic& value) {
  for (const auto& action :
       converted<std::vector<AccessibilityAction>>(state, value, {})) {
    state.view.accessibility_actions.push_back(
        {action.name, action.label.value_or("")});
  }
}

void setAccessibilityOrder(ParseState& state, const folly::dynamic& value) {
  for (const auto& tag :
       converted<std::vector<std::string>>(state, value, {})) {
    state.view.accessibility_order.push_back(tag);
  }
}

void setAccessibilityLabelledBy(
    ParseState& state,
    const folly::dynamic& value) {
  for (const auto& nativeId :
       converted<AccessibilityLabelledBy>(state, value, {}).value) {
    state.view.accessibility_labelled_by.push_back(nativeId);
  }
}

void setAccessibilityLiveRegion(
    ParseState& state,
    const folly::dynamic& value) {
  state.view.accessibility_live_region =
      static_cast<uint8_t>(converted<AccessibilityLiveRegion>(
          state, value, AccessibilityLiveRegion::None));
}

void setImportantForAccessibility(
    ParseState& state,
    const folly::dynamic& value) {
  state.view.accessibility_important =
      static_cast<uint8_t>(converted<ImportantForAccessibility>(
          state, value, ImportantForAccessibility::Auto));
}

void setAccessibilityRole(ParseState& state, const folly::dynamic& value) {
  state.accessibilityRole = value.isNull() ? nullptr : &value;
}

void setRole(ParseState& state, const folly::dynamic& value) {
  state.role = value.isNull() ? nullptr : &value;
}

void setSelectable(ParseState& state, const folly::dynamic& value) {
  state.flags.selectable = converted<bool>(state, value, false);
}

void setOnTextLayout(ParseState& state, const folly::dynamic& value) {
  state.flags.onTextLayout = converted<bool>(state, value, false);
}

#define EDGE_ENTRIES(Fn, Type, Prefix, Suffix)              \
  {Prefix "Left" Suffix, &Fn<&Type::left>},                 \
      {Prefix "Right" Suffix, &Fn<&Type::right>},           \
      {Prefix "Top" Suffix, &Fn<&Type::top>},               \
      {Prefix "Bottom" Suffix, &Fn<&Type::bottom>},         \
      {Prefix "Start" Suffix, &Fn<&Type::start>},           \
      {Prefix "End" Suffix, &Fn<&Type::end>},               \
      {Prefix "Horizontal" Suffix, &Fn<&Type::horizontal>}, \
      {Prefix "Vertical" Suffix, &Fn<&Type::vertical>}, {   \
    Prefix "" Suffix, &Fn<&Type::all>                       \
  }

#define BLOCK_ENTRIES(Fn, Type, Prefix, Suffix)           \
  {Prefix "Block" Suffix, &Fn<&Type::block>},             \
      {Prefix "BlockEnd" Suffix, &Fn<&Type::blockEnd>}, { \
    Prefix "BlockStart" Suffix, &Fn<&Type::blockStart>    \
  }

const std::unordered_map<std::string_view, Handler>& handlers() {
  static const std::unordered_map<std::string_view, Handler> table = {
      {"opacity", &setOpacity},
      {"backgroundColor", &setBackgroundColor},
      {"backgroundImage", &setBackgroundImage},
      {"experimental_backgroundImage", &setBackgroundImage},
      {"experimental_backgroundSize", &setBackgroundSize},
      {"experimental_backgroundPosition", &setBackgroundPosition},
      {"experimental_backgroundRepeat", &setBackgroundRepeat},
      {"boxShadow", &setBoxShadow},
      {"filter", &setFilter},
      {"mixBlendMode", &setMixBlendMode},
      {"isolation", &setIsolation},
      {"hitSlop", &setHitSlop},
      {"backfaceVisibility", &setBackfaceVisibility},
      {"outlineColor", &setOutlineColor},
      {"outlineWidth", &setOutlineWidth},
      {"outlineOffset", &setOutlineOffset},
      {"outlineStyle", &setOutlineStyle},
      {"overflow", &setOverflow},
      {"pointerEvents", &setPointerEvents},
      {"cursor", &setCursor},
      {"transform", &setTransform},
      {"transformOrigin", &setTransformOrigin},
      EDGE_ENTRIES(setBorderColor, CascadedBorderColors, "border", "Color"),
      BLOCK_ENTRIES(setBorderColor, CascadedBorderColors, "border", "Color"),
      EDGE_ENTRIES(setBorderStyle, CascadedBorderStyles, "border", "Style"),
      BLOCK_ENTRIES(setBorderStyle, CascadedBorderStyles, "border", "Style"),
      EDGE_ENTRIES(setBorderWidth, CascadedBorderWidths, "border", "Width"),
      {"borderTopLeftRadius", &setBorderRadius<&CascadedBorderRadii::topLeft>},
      {"borderTopRightRadius",
       &setBorderRadius<&CascadedBorderRadii::topRight>},
      {"borderBottomLeftRadius",
       &setBorderRadius<&CascadedBorderRadii::bottomLeft>},
      {"borderBottomRightRadius",
       &setBorderRadius<&CascadedBorderRadii::bottomRight>},
      {"borderTopStartRadius",
       &setBorderRadius<&CascadedBorderRadii::topStart>},
      {"borderTopEndRadius", &setBorderRadius<&CascadedBorderRadii::topEnd>},
      {"borderBottomStartRadius",
       &setBorderRadius<&CascadedBorderRadii::bottomStart>},
      {"borderBottomEndRadius",
       &setBorderRadius<&CascadedBorderRadii::bottomEnd>},
      {"borderEndEndRadius", &setBorderRadius<&CascadedBorderRadii::endEnd>},
      {"borderEndStartRadius",
       &setBorderRadius<&CascadedBorderRadii::endStart>},
      {"borderStartEndRadius",
       &setBorderRadius<&CascadedBorderRadii::startEnd>},
      {"borderStartStartRadius",
       &setBorderRadius<&CascadedBorderRadii::startStart>},
      {"borderRadius", &setBorderRadius<&CascadedBorderRadii::all>},
      {"accessible", &setAccessible},
      {"accessibilityViewIsModal", &setAccessibilityViewIsModal},
      {"accessibilityElementsHidden", &setAccessibilityElementsHidden},
      {"accessibilityIgnoresInvertColors",
       &setAccessibilityIgnoresInvertColors},
      {"accessibilityShowsLargeContentViewer",
       &setAccessibilityShowsLargeContent},
      {"accessibilityRespondsToUserInteraction",
       &setAccessibilityRespondsToInteraction},
      {"onAccessibilityTap", &setOnAccessibilityTap},
      {"onAccessibilityMagicTap", &setOnAccessibilityMagicTap},
      {"onAccessibilityEscape", &setOnAccessibilityEscape},
      {"onAccessibilityAction", &setOnAccessibilityAction},
      {"accessibilityLabel", &setAccessibilityLabel},
      {"accessibilityHint", &setAccessibilityHint},
      {"accessibilityLanguage", &setAccessibilityLanguage},
      {"accessibilityLargeContentTitle", &setAccessibilityLargeContentTitle},
      {"accessibilityState", &setAccessibilityState},
      {"accessibilityValue", &setAccessibilityValue},
      {"accessibilityActions", &setAccessibilityActions},
      {"experimental_accessibilityOrder", &setAccessibilityOrder},
      {"accessibilityLabelledBy", &setAccessibilityLabelledBy},
      {"accessibilityLiveRegion", &setAccessibilityLiveRegion},
      {"importantForAccessibility", &setImportantForAccessibility},
      {"accessibilityRole", &setAccessibilityRole},
      {"role", &setRole},
      {"testID", &setTestId},
      {"nativeID", &setNativeId},
      {"focusable", &setFocusable},
      {"desktopDragRegion", &setDesktopDragRegion},
      {"group", &setGroup},
      {"hoverStyle", &setHoverStyle},
      {"activeStyle", &setActiveStyle},
      {"focusStyle", &setFocusStyle},
      {"focusVisibleStyle", &setFocusVisibleStyle},
      {"groupHoverStyle", &setGroupHoverStyle},
      {"groupActiveStyle", &setGroupActiveStyle},
      {"dragOverStyle", &setDragOverStyle},
      {"acceptsFiles", &setAcceptsFiles},
      {"tooltip", &setTooltip},
      {"draggable", &setDraggable},
      {"droppable", &setDroppable},
      {"onContextMenu", &setOnContextMenu},
      {"onContextMenuCapture", &setOnContextMenuCapture},
      {"onWheel", &setOnWheel},
      {"onWheelCapture", &setOnWheelCapture},
      {"onLayout", &setOnLayout},
      {"selectable", &setSelectable},
      {"onTextLayout", &setOnTextLayout},
  };
  return table;
}

void finishAccessibility(ParseState& state) {
  auto& view = state.view;
  // `role` wins over `accessibilityRole` for both the trait and the name.
  const auto* precedent =
      state.role != nullptr ? state.role : state.accessibilityRole;
  AccessibilityTraits traits = AccessibilityTraits::None;
  if (precedent != nullptr) {
    convert(state, *precedent, traits);
  }
  if (state.accessibilityRole != nullptr) {
    view.accessibility_role =
        converted<std::string>(state, *state.accessibilityRole, std::string{});
  }
  if (state.role != nullptr) {
    const auto role = converted<Role>(state, *state.role, Role::None);
    if (role != Role::None) {
      view.accessibility_role = toString(role);
    }
  }
  view.accessibility_traits = static_cast<uint32_t>(traits);
  view.accessibility_disabled = (view.accessibility_traits & (1u << 8)) != 0;
  view.accessibility_selected = (view.accessibility_traits & (1u << 3)) != 0;

  const auto& value = state.accessibilityValue;
  if (value.min) {
    view.accessibility_has_value_min = true;
    view.accessibility_value_min = *value.min;
  }
  if (value.max) {
    view.accessibility_has_value_max = true;
    view.accessibility_value_max = *value.max;
  }
  if (value.now) {
    view.accessibility_has_value_now = true;
    view.accessibility_value_now = *value.now;
  }
  if (value.text) {
    view.accessibility_value_text = *value.text;
  }

  if (state.accessibilityState) {
    const auto& accessibilityState = *state.accessibilityState;
    view.accessibility_disabled =
        accessibilityState.disabled || view.accessibility_disabled;
    view.accessibility_selected =
        accessibilityState.selected || view.accessibility_selected;
    view.accessibility_busy = accessibilityState.busy;
    switch (accessibilityState.checked) {
      case AccessibilityState::Unchecked:
        view.accessibility_checked = 1;
        break;
      case AccessibilityState::Checked:
        view.accessibility_checked = 2;
        break;
      case AccessibilityState::Mixed:
        view.accessibility_checked = 3;
        break;
      case AccessibilityState::None:
        break;
    }
    if (accessibilityState.expanded) {
      view.accessibility_expanded = *accessibilityState.expanded ? 1 : 0;
    }
  }
}

} // namespace

void initLoomView(ViewPropsFlat& view) {
  view.opacity = 1.f;
  view.outline_style = static_cast<uint8_t>(OutlineStyle::Solid);
  view.accessibility_responds_to_interaction = true;
  view.accessibility_expanded = -1;
  view.transform = Transform::Identity().matrix;
}

void parseLoomViewProps(
    const PropsParserContext& context,
    const folly::dynamic& props,
    ViewPropsFlat& view,
    LoomViewFlags& flags,
    std::unique_ptr<LoomViewDeps>& deps) {
  ParseState state{context, view, flags, deps};
  const auto& table = handlers();
  if (props.isObject()) {
    for (const auto& [key, value] : props.items()) {
      if (!key.isString()) {
        continue;
      }
      const auto found = table.find(key.getString());
      if (found != table.end()) {
        found->second(state, value);
      }
    }
  }

  if (!state.backgroundImage.empty()) {
    view.background_json = backgroundJson(
        state.backgroundImage,
        state.backgroundSize,
        state.backgroundPosition,
        state.backgroundRepeat);
  }

  const auto colors = state.colors.resolve(false, SharedColor{});
  view.border_colors = {
      argb(colors.left),
      argb(colors.top),
      argb(colors.right),
      argb(colors.bottom)};
  const auto styles = state.styles.resolve(false, BorderStyle::Solid);
  view.border_styles = {
      static_cast<uint8_t>(styles.left),
      static_cast<uint8_t>(styles.top),
      static_cast<uint8_t>(styles.right),
      static_cast<uint8_t>(styles.bottom)};

  const auto widths = state.widths.resolve(false, 0);
  view.border_widths = {widths.left, widths.top, widths.right, widths.bottom};
  if (state.widths.start || state.widths.end) {
    auto& dependent = state.ensureDeps();
    dependent.widths = state.widths;
    dependent.widthsDirectional = true;
  }

  const auto radii = state.radii.resolve(false, ValueUnit{0, UnitType::Point});
  const auto point = [](const ValueUnit& unit) { return unit.resolve(0); };
  view.border_radii = {
      point(radii.topLeft),
      point(radii.topRight),
      point(radii.bottomRight),
      point(radii.bottomLeft)};
  for (const auto* corner :
       {&radii.topLeft,
        &radii.topRight,
        &radii.bottomRight,
        &radii.bottomLeft}) {
    if (corner->unit == UnitType::Percent) {
      auto& dependent = state.ensureDeps();
      dependent.radii = state.radii;
      dependent.radiiPercent = true;
      break;
    }
  }

  finishAccessibility(state);
  view.on_context_menu = state.contextMenu || state.contextMenuCapture;
  view.on_wheel = state.wheel || state.wheelCapture;
  if (deps && deps->transformOrigin.isSet()) {
    view.transform_origin_set = true;
  }
}

void resolveLoomViewLayout(
    ViewPropsFlat& view,
    const LoomViewDeps* deps,
    const Size& frameSize,
    bool rtl,
    uint8_t mask) {
  if (deps == nullptr) {
    return;
  }
  if ((mask & kPatchRadii) != 0 && deps->radiiPercent) {
    const auto radii =
        deps->radii.resolve(false, ValueUnit{0, UnitType::Point});
    const auto side = std::min(frameSize.width, frameSize.height);
    view.border_radii = {
        radii.topLeft.resolve(side),
        radii.topRight.resolve(side),
        radii.bottomRight.resolve(side),
        radii.bottomLeft.resolve(side)};
  }
  if ((mask & kPatchWidths) != 0 && deps->widthsDirectional) {
    const auto widths = deps->widths.resolve(rtl, 0);
    view.border_widths = {widths.left, widths.top, widths.right, widths.bottom};
  }
  if ((mask & kPatchTransform) != 0) {
    const auto transform = BaseViewProps::resolveTransform(
        frameSize, deps->transform, deps->transformOrigin);
    view.transform = transform.matrix;
    view.has_transform = !(transform == Transform::Identity());
    view.transform_origin_set = deps->transformOrigin.isSet();
  }
}

} // namespace rngpui

#endif // LOOM_RENDERER
