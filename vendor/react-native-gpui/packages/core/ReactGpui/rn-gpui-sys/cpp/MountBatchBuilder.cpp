#include "MountBatchBuilder.h"
#include "GpuiHostComponentsCpp.h"
#include "GpuiModules.h"
#include "GpuiTextMeasure.h"

#include <algorithm>
#include <cmath>

#include <react/renderer/components/FBReactNativeSpec/Props.h>
#include <react/renderer/components/iostextinput/TextInputProps.h>
#include <react/renderer/components/scrollview/ScrollViewProps.h>
#include <react/renderer/components/scrollview/ScrollViewState.h>
#include <react/renderer/components/text/BaseParagraphProps.h>
#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/components/textinput/TextInputState.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/components/view/accessibilityPropsConversions.h>
#include <react/renderer/core/ConcreteState.h>

#include <folly/json.h>
#include <algorithm>
#include <cmath>
#include <mutex>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace rngpui {
using namespace facebook::react;

uint32_t argb(const SharedColor& color) {
  if (!color) {
    return 0;
  }
  auto components = colorComponentsFromColor(color);
  auto to8 = [](float v) {
    return static_cast<uint32_t>(std::lround(v * 255.f)) & 0xFF;
  };
  return (to8(components.alpha) << 24) | (to8(components.red) << 16) |
      (to8(components.green) << 8) | to8(components.blue);
}

// Shadow and fit settings: the shadow is the first fragment's, as alignment is.
static void applyParagraphExtras(
    ParagraphFlat& out,
    const AttributedString::Fragments& fragments,
    const ParagraphAttributes& attributes) {
  out.adjusts_to_fit = attributes.adjustsFontSizeToFit;
  out.min_font_scale = std::isnan(attributes.minimumFontScale)
      ? 0.f
      : attributes.minimumFontScale;
  if (fragments.empty()) {
    return;
  }
  const auto& first = fragments.front().textAttributes;
  if (first.textShadowColor) {
    out.shadow_color = argb(first.textShadowColor);
    if (first.textShadowOffset) {
      out.shadow_dx = first.textShadowOffset->width;
      out.shadow_dy = first.textShadowOffset->height;
    }
    out.shadow_radius =
        std::isnan(first.textShadowRadius) ? 0.f : first.textShadowRadius;
  }
}

static folly::dynamic unitJson(const ValueUnit& unit) {
  switch (unit.unit) {
    case UnitType::Point:
      return folly::dynamic::object("unit", "pt")("value", unit.value);
    case UnitType::Percent:
      return folly::dynamic::object("unit", "pct")("value", unit.value);
    default:
      return folly::dynamic::object("unit", "none")("value", 0);
  }
}

// A repeating gradient arrives with a first color stop far before the start.
static bool hasRepeatingMarker(const std::vector<ColorStop>& stops) {
  return !stops.empty() && stops.front().position.unit == UnitType::Point &&
      stops.front().position.value <= -99999999.f;
}

static folly::dynamic stopsJson(const std::vector<ColorStop>& stops) {
  folly::dynamic array = folly::dynamic::array;
  for (const auto& stop : stops) {
    if (&stop == &stops.front() && hasRepeatingMarker(stops)) {
      continue;
    }
    array.push_back(folly::dynamic::object("color", argb(stop.color))(
        "position", unitJson(stop.position)));
  }
  return array;
}

static folly::dynamic optionalUnitJson(const std::optional<ValueUnit>& unit) {
  return unit ? unitJson(*unit) : folly::dynamic(nullptr);
}

// The gradients, their size, position and repeat, as JSON the renderer reads.
std::string backgroundJson(
    const std::vector<BackgroundImage>& images,
    const std::vector<BackgroundSize>& backgroundSizes,
    const std::vector<BackgroundPosition>& backgroundPositions,
    const std::vector<BackgroundRepeat>& backgroundRepeats) {
  if (images.empty()) {
    return {};
  }
  folly::dynamic layers = folly::dynamic::array;
  for (const auto& image : images) {
    if (const auto* linear = std::get_if<LinearGradient>(&image)) {
      folly::dynamic layer = folly::dynamic::object("kind", "linear");
      if (const auto* angle = std::get_if<Float>(&linear->direction)) {
        layer["angle"] = *angle;
      } else if (
          const auto* keyword =
              std::get_if<GradientKeyword>(&linear->direction)) {
        switch (*keyword) {
          case GradientKeyword::ToTopRight:
            layer["keyword"] = "top-right";
            break;
          case GradientKeyword::ToBottomRight:
            layer["keyword"] = "bottom-right";
            break;
          case GradientKeyword::ToTopLeft:
            layer["keyword"] = "top-left";
            break;
          case GradientKeyword::ToBottomLeft:
            layer["keyword"] = "bottom-left";
            break;
        }
      }
      layer["stops"] = stopsJson(linear->colorStops);
      layer["repeating"] = hasRepeatingMarker(linear->colorStops);
      layers.push_back(std::move(layer));
    } else if (const auto* radial = std::get_if<RadialGradient>(&image)) {
      folly::dynamic layer = folly::dynamic::object("kind", "radial");
      layer["shape"] =
          radial->shape == RadialGradientShape::Circle ? "circle" : "ellipse";
      if (const auto* keyword = std::get_if<RadialGradientSize::SizeKeyword>(
              &radial->size.value)) {
        switch (*keyword) {
          case RadialGradientSize::SizeKeyword::ClosestSide:
            layer["size"] = "closest-side";
            break;
          case RadialGradientSize::SizeKeyword::FarthestSide:
            layer["size"] = "farthest-side";
            break;
          case RadialGradientSize::SizeKeyword::ClosestCorner:
            layer["size"] = "closest-corner";
            break;
          case RadialGradientSize::SizeKeyword::FarthestCorner:
            layer["size"] = "farthest-corner";
            break;
        }
      } else if (
          const auto* dimensions = std::get_if<RadialGradientSize::Dimensions>(
              &radial->size.value)) {
        layer["size"] = folly::dynamic::object("x", unitJson(dimensions->x))(
            "y", unitJson(dimensions->y));
      }
      layer["position"] =
          folly::dynamic::object("top", optionalUnitJson(radial->position.top))(
              "left", optionalUnitJson(radial->position.left))(
              "right", optionalUnitJson(radial->position.right))(
              "bottom", optionalUnitJson(radial->position.bottom));
      layer["stops"] = stopsJson(radial->colorStops);
      layer["repeating"] = hasRepeatingMarker(radial->colorStops);
      layers.push_back(std::move(layer));
    }
  }
  folly::dynamic sizes = folly::dynamic::array;
  for (const auto& size : backgroundSizes) {
    if (const auto* keyword = std::get_if<BackgroundSizeKeyword>(&size)) {
      sizes.push_back(
          *keyword == BackgroundSizeKeyword::Cover ? "cover" : "contain");
    } else if (
        const auto* lengths =
            std::get_if<BackgroundSizeLengthPercentage>(&size)) {
      sizes.push_back(folly::dynamic::object(
          "x",
          lengths->isXAuto() ? folly::dynamic(nullptr)
                             : unitJson(std::get<ValueUnit>(lengths->x)))(
          "y",
          lengths->isYAuto() ? folly::dynamic(nullptr)
                             : unitJson(std::get<ValueUnit>(lengths->y))));
    }
  }
  folly::dynamic positions = folly::dynamic::array;
  for (const auto& position : backgroundPositions) {
    positions.push_back(
        folly::dynamic::object("top", optionalUnitJson(position.top))(
            "left", optionalUnitJson(position.left))(
            "right", optionalUnitJson(position.right))(
            "bottom", optionalUnitJson(position.bottom)));
  }
  auto repeatName = [](BackgroundRepeatStyle style) {
    switch (style) {
      case BackgroundRepeatStyle::Space:
        return "space";
      case BackgroundRepeatStyle::Round:
        return "round";
      case BackgroundRepeatStyle::NoRepeat:
        return "no-repeat";
      default:
        return "repeat";
    }
  };
  folly::dynamic repeats = folly::dynamic::array;
  for (const auto& repeat : backgroundRepeats) {
    repeats.push_back(folly::dynamic::object("x", repeatName(repeat.x))(
        "y", repeatName(repeat.y)));
  }
  return folly::toJson(folly::dynamic::object("layers", layers)("sizes", sizes)(
      "positions", positions)("repeats", repeats));
}

TextFragmentFlat flattenTextFragment(
    const TextAttributes& attributes,
    const std::string& text) {
  TextFragmentFlat out{};
  out.text = text;
  out.font_family = attributes.fontFamily;
  // allowFontScaling and maxFontSizeMultiplier decide how much of the system
  // text scale (carried in fontSizeMultiplier) this fragment follows.
  float scale = std::isnan(attributes.fontSizeMultiplier)
      ? 1.f
      : attributes.fontSizeMultiplier;
  if (attributes.allowFontScaling && !*attributes.allowFontScaling) {
    scale = 1.f;
  } else if (
      !std::isnan(attributes.maxFontSizeMultiplier) &&
      attributes.maxFontSizeMultiplier >= 1.f) {
    scale = std::min(scale, attributes.maxFontSizeMultiplier);
  }
  out.font_size =
      (std::isnan(attributes.fontSize) ? 14.f : attributes.fontSize) * scale;
  if (attributes.textTransform) {
    switch (*attributes.textTransform) {
      case TextTransform::Uppercase:
        out.text_transform = 1;
        break;
      case TextTransform::Lowercase:
        out.text_transform = 2;
        break;
      case TextTransform::Capitalize:
        out.text_transform = 3;
        break;
      default:
        break;
    }
  }
  out.background_color = argb(attributes.backgroundColor);
  out.font_variant = attributes.fontVariant
      ? static_cast<uint32_t>(*attributes.fontVariant)
      : 0;
  out.font_weight = attributes.fontWeight
      ? static_cast<uint16_t>(*attributes.fontWeight)
      : 400;
  out.italic =
      attributes.fontStyle && *attributes.fontStyle != FontStyle::Normal;
  out.color = argb(attributes.foregroundColor);
  out.line_height =
      std::isnan(attributes.lineHeight) ? 0.f : attributes.lineHeight * scale;
  out.letter_spacing =
      std::isnan(attributes.letterSpacing) ? 0.f : attributes.letterSpacing;
  if (attributes.textDecorationLineType) {
    switch (*attributes.textDecorationLineType) {
      case TextDecorationLineType::Underline:
        out.underline = true;
        break;
      case TextDecorationLineType::Strikethrough:
        out.strikethrough = true;
        break;
      case TextDecorationLineType::UnderlineStrikethrough:
        out.underline = true;
        out.strikethrough = true;
        break;
      case TextDecorationLineType::None:
        break;
    }
  }
  return out;
}

// The `filter` functions in order, as `[[name, amount], ...]`; a `dropShadow`
// carries `{x, y, blur, color}` in place of the amount.
std::string filterJson(const std::vector<FilterFunction>& filter) {
  if (filter.empty()) {
    return {};
  }
  folly::dynamic functions = folly::dynamic::array;
  for (const auto& function : filter) {
    if (const auto* amount = std::get_if<Float>(&function.parameters)) {
      functions.push_back(
          folly::dynamic::array(toString(function.type), *amount));
    } else if (
        const auto* shadow =
            std::get_if<DropShadowParams>(&function.parameters)) {
      functions.push_back(folly::dynamic::array(
          toString(function.type),
          folly::dynamic::object("x", shadow->offsetX)("y", shadow->offsetY)(
              "blur", shadow->standardDeviation)(
              "color", static_cast<int64_t>(argb(shadow->color)))));
    }
  }
  if (functions.empty()) {
    return {};
  }
  return folly::toJson(functions);
}

static ViewPropsFlat flattenView(const ShadowView& shadowView) {
  ViewPropsFlat out{};
  // Non-view components must remain opaque; a value-initialized flat struct
  // otherwise silently turns an unrecognized props type fully transparent.
  out.opacity = 1.f;
  out.display_none = shadowView.layoutMetrics.displayType == DisplayType::None;
  auto props = std::dynamic_pointer_cast<const BaseViewProps>(shadowView.props);
  if (!props) {
    return out;
  }

  out.opacity = props->opacity;
  out.background_color = argb(props->backgroundColor);
  out.background_json = backgroundJson(
      props->backgroundImage,
      props->backgroundSize,
      props->backgroundPosition,
      props->backgroundRepeat);
  out.filter_json = filterJson(props->filter);
  out.mix_blend_mode = static_cast<uint8_t>(props->mixBlendMode);
  out.isolate = props->isolation == Isolation::Isolate;
  out.hit_slop = {
      props->hitSlop.left,
      props->hitSlop.top,
      props->hitSlop.right,
      props->hitSlop.bottom};
  out.backface_hidden = props->backfaceVisibility == BackfaceVisibility::Hidden;

  // layoutMetrics.borderWidth is already fully resolved per edge; the cascaded
  // props->getBorderWidths() would need the same resolve() dance as the colors.
  const auto& layoutMetrics = shadowView.layoutMetrics;
  out.border_widths = {
      layoutMetrics.borderWidth.left,
      layoutMetrics.borderWidth.top,
      layoutMetrics.borderWidth.right,
      layoutMetrics.borderWidth.bottom};
  out.content_insets = {
      layoutMetrics.contentInsets.left,
      layoutMetrics.contentInsets.top,
      layoutMetrics.contentInsets.right,
      layoutMetrics.contentInsets.bottom};

  auto colors = props->borderColors.resolve(/*isRTL*/ false, SharedColor{});
  out.border_colors = {
      argb(colors.left),
      argb(colors.top),
      argb(colors.right),
      argb(colors.bottom)};
  auto borderStyles = props->borderStyles.resolve(false, BorderStyle::Solid);
  out.border_styles = {
      static_cast<uint8_t>(borderStyles.left),
      static_cast<uint8_t>(borderStyles.top),
      static_cast<uint8_t>(borderStyles.right),
      static_cast<uint8_t>(borderStyles.bottom)};
  out.outline_color = argb(props->outlineColor);
  out.outline_width = props->outlineWidth;
  out.outline_offset = props->outlineOffset;
  out.outline_style = static_cast<uint8_t>(props->outlineStyle);

  // BorderRadii is RectangleCorners<ValueUnit>; each corner resolves to px
  // against the frame's smaller side (percentage radii).
  auto radii = props->borderRadii.resolve(false, ValueUnit{0, UnitType::Point});
  auto px = [&](const ValueUnit& v) {
    return v.resolve(std::min(
        layoutMetrics.frame.size.width, layoutMetrics.frame.size.height));
  };
  out.border_radii = {
      px(radii.topLeft),
      px(radii.topRight),
      px(radii.bottomRight),
      px(radii.bottomLeft)};

  out.overflow_hidden = props->getClipsContentToBounds();
  out.pointer_events = static_cast<uint8_t>(props->pointerEvents);
  // `Cursor` is `enum class Cursor : uint8_t` in this exact order, starting at
  // Auto = 0; `style::cursor_style` in `rn-gpui` spells the same ordinals out.
  out.cursor = static_cast<uint8_t>(props->cursor);

  for (const auto& shadow : props->boxShadow) {
    out.shadows.push_back(
        {shadow.offsetX,
         shadow.offsetY,
         shadow.blurRadius,
         shadow.spreadDistance,
         argb(shadow.color),
         shadow.inset});
  }

  out.test_id = props->testId;
  out.accessibility_native_id = props->nativeId;
  out.accessible = props->accessible;
  out.accessibility_label = props->accessibilityLabel;
  out.accessibility_hint = props->accessibilityHint;
  out.accessibility_language = props->accessibilityLanguage;
  out.accessibility_role = props->accessibilityRole;
  if (props->role != Role::None) {
    out.accessibility_role = toString(props->role);
  }
  out.accessibility_traits = static_cast<uint32_t>(props->accessibilityTraits);
  for (const auto& tag : props->accessibilityOrder) {
    out.accessibility_order.push_back(tag);
  }
  for (const auto& nativeId : props->accessibilityLabelledBy.value) {
    out.accessibility_labelled_by.push_back(nativeId);
  }
  out.accessibility_hidden = props->accessibilityElementsHidden;
  out.accessibility_modal = props->accessibilityViewIsModal;
  out.accessibility_ignores_invert_colors =
      props->accessibilityIgnoresInvertColors;
  out.accessibility_large_content_enabled =
      props->accessibilityShowsLargeContentViewer;
  out.accessibility_large_content_title = props->accessibilityLargeContentTitle;
  out.accessibility_responds_to_interaction =
      props->accessibilityRespondsToUserInteraction;
  out.accessibility_has_action_listener = props->onAccessibilityAction;
  out.accessibility_has_tap_listener = props->onAccessibilityTap;
  out.accessibility_has_escape_listener = props->onAccessibilityEscape;
  out.accessibility_has_magic_tap_listener = props->onAccessibilityMagicTap;
  out.accessibility_important =
      static_cast<uint8_t>(props->importantForAccessibility);
  out.accessibility_live_region =
      static_cast<uint8_t>(props->accessibilityLiveRegion);
  for (const auto& action : props->accessibilityActions) {
    out.accessibility_actions.push_back(
        {action.name, action.label.value_or("")});
  }
  out.accessibility_disabled = (out.accessibility_traits & (1u << 8)) != 0;
  out.accessibility_selected = (out.accessibility_traits & (1u << 3)) != 0;
  const auto& accessibilityValue = props->accessibilityValue;
  if (accessibilityValue.min) {
    out.accessibility_has_value_min = true;
    out.accessibility_value_min = *accessibilityValue.min;
  }
  if (accessibilityValue.max) {
    out.accessibility_has_value_max = true;
    out.accessibility_value_max = *accessibilityValue.max;
  }
  if (accessibilityValue.now) {
    out.accessibility_has_value_now = true;
    out.accessibility_value_now = *accessibilityValue.now;
  }
  if (accessibilityValue.text) {
    out.accessibility_value_text = *accessibilityValue.text;
  }
  if (props->accessibilityState) {
    const auto& state = *props->accessibilityState;
    out.accessibility_disabled =
        state.disabled || (out.accessibility_traits & (1u << 8)) != 0;
    out.accessibility_selected =
        state.selected || (out.accessibility_traits & (1u << 3)) != 0;
    out.accessibility_busy = state.busy;
    switch (state.checked) {
      case AccessibilityState::Unchecked:
        out.accessibility_checked = 1;
        break;
      case AccessibilityState::Checked:
        out.accessibility_checked = 2;
        break;
      case AccessibilityState::Mixed:
        out.accessibility_checked = 3;
        break;
      case AccessibilityState::None:
        break;
    }
    if (state.expanded) {
      out.accessibility_expanded = *state.expanded ? 1 : 0;
    } else {
      out.accessibility_expanded = -1;
    }
  } else {
    out.accessibility_expanded = -1;
  }
  if (auto platformProps =
          std::dynamic_pointer_cast<const ViewProps>(shadowView.props)) {
    out.focusable = platformProps->focusable;
    out.desktop_drag_region = platformProps->desktopDragRegion;
    out.on_context_menu = platformProps->onContextMenu;
    out.on_wheel = platformProps->onWheel;
    out.group = platformProps->group;
    out.hover_style = platformProps->hoverStyle;
    out.active_style = platformProps->activeStyle;
    out.focus_style = platformProps->focusStyle;
    out.focus_visible_style = platformProps->focusVisibleStyle;
    out.group_hover_style = platformProps->groupHoverStyle;
    out.group_active_style = platformProps->groupActiveStyle;
    out.drag_over_style = platformProps->dragOverStyle;
    out.accepts_files = platformProps->acceptsFiles;
    out.tooltip = platformProps->tooltip;
    out.draggable = platformProps->draggable;
    out.droppable = platformProps->droppable;
  }

  const auto transform = props->resolveTransform(layoutMetrics);
  out.transform_origin_set = props->transformOrigin.isSet();
  out.transform = transform.matrix;
  out.has_transform = !(transform == Transform::Identity());
  return out;
}

ParagraphFlat flattenParagraphText(
    const AttributedString& attributedString,
    const ParagraphAttributes& attributes,
    bool selectable) {
  ParagraphFlat out{};
  const auto& fragments = attributedString.getFragments();
  out.fragments.reserve(fragments.size());
  for (const auto& fragment : fragments) {
    out.fragments.push_back(
        flattenTextFragment(fragment.textAttributes, fragment.string));
  }

  // Text alignment lives on TextAttributes, not on ParagraphAttributes: take
  // it from the first fragment (they are homogeneous in practice). The
  // TextAlignment enum values already match the ParagraphFlat encoding.
  if (!fragments.empty() && fragments.front().textAttributes.alignment) {
    out.text_align =
        static_cast<uint8_t>(*fragments.front().textAttributes.alignment);
  }

  applyParagraphExtras(out, fragments, attributes);
  out.selectable = selectable;
  out.max_lines = attributes.maximumNumberOfLines;
  // EllipsizeMode is {Clip=0, Head=1, Tail=2, Middle=3} but the GPUI slot
  // encodes {0 tail, 1 head, 2 middle, 3 clip}.
  switch (attributes.ellipsizeMode) {
    case EllipsizeMode::Clip:
      out.ellipsize = 3;
      break;
    case EllipsizeMode::Head:
      out.ellipsize = 1;
      break;
    case EllipsizeMode::Tail:
      out.ellipsize = 0;
      break;
    case EllipsizeMode::Middle:
      out.ellipsize = 2;
      break;
  }
  return out;
}

static ParagraphFlat flattenParagraph(const ShadowView& shadowView) {
  auto state = std::dynamic_pointer_cast<const ConcreteState<ParagraphState>>(
      shadowView.state);
  if (!state) {
    return ParagraphFlat{};
  }
  const auto paragraphProps =
      std::dynamic_pointer_cast<const BaseParagraphProps>(shadowView.props);
  const auto& data = state->getData();
  return flattenParagraphText(
      data.attributedString,
      data.paragraphAttributes,
      paragraphProps && paragraphProps->isSelectable);
}

ParagraphFlat flattenInputText(const AttributedString& attributedString) {
  ParagraphFlat out{};
  for (const auto& fragment : attributedString.getFragments()) {
    out.fragments.push_back(
        flattenTextFragment(fragment.textAttributes, fragment.string));
  }
  return out;
}

rust::Str componentNameStr(const char* name) {
  if (name == nullptr) {
    return {};
  }
  thread_local std::unordered_map<const char*, rust::Str> cache;
  if (const auto found = cache.find(name); found != cache.end() &&
      std::string_view(found->second.data(), found->second.size()) == name) {
    return found->second;
  }
  static std::mutex mutex;
  static std::unordered_set<std::string> names;
  std::string_view interned;
  {
    std::lock_guard<std::mutex> lock(mutex);
    interned = *names.emplace(name).first;
  }
  const rust::Str str(interned.data(), interned.size());
  cache.insert_or_assign(name, str);
  return str;
}

MountOp buildMountOp(const ShadowViewMutation& mutation) {
  MountOp op{};
  op.kind = static_cast<MountKind>(mutation.type);
  op.parent_tag = mutation.parentTag;
  op.index = mutation.index;

  const ShadowView& shadowView = (mutation.type == ShadowViewMutation::Delete ||
                                  mutation.type == ShadowViewMutation::Remove)
      ? mutation.oldChildShadowView
      : mutation.newChildShadowView;

  op.tag = shadowView.tag;
  op.component = componentNameStr(shadowView.componentName);
  const std::string componentName(op.component.data(), op.component.size());
  {
    const auto& registered =
        gpuiExtensionHooks().componentProps.find(componentName);
    if (registered != gpuiExtensionHooks().componentProps.end() &&
        shadowView.props) {
      op.extension_props_json = registered->second(componentName, shadowView);
    }
  }
  op.host_index = -1;
  op.host_props_handle = 0;
  op.host_emitter_handle = 0;
  op.host_changed = 0;
  if (rngpui::anyHostComponents() &&
      (mutation.type == ShadowViewMutation::Create ||
       mutation.type == ShadowViewMutation::Update)) {
    if (const auto* entry =
            rngpui::hostComponentEntry(shadowView.componentHandle)) {
      op.host_index = static_cast<int32_t>(entry->index);
      if (mutation.type == ShadowViewMutation::Create) {
        op.host_props_handle = rngpui::makeHostPropsHandle(shadowView.props);
        op.host_emitter_handle =
            rngpui::makeHostEmitterHandle(shadowView.eventEmitter);
      } else {
        const auto& before = mutation.oldChildShadowView.props;
        const auto& after = mutation.newChildShadowView.props;
        if (before && after && before.get() != after.get()) {
          uint64_t inlineWords[2] = {0, 0};
          std::vector<uint64_t> heapWords;
          uint64_t* words = inlineWords;
          if (entry->changeWords > 2) {
            heapWords.assign(entry->changeWords, 0);
            words = heapWords.data();
          }
          entry->changed(*before, *after, words);
          bool any = false;
          for (uint32_t word = 0; word < entry->changeWords; ++word) {
            any = any || words[word] != 0;
          }
          if (any) {
            op.host_props_handle = rngpui::makeHostPropsHandle(after);
            op.host_changed = words[0];
            for (uint32_t word = 1; word < entry->changeWords; ++word) {
              op.host_changed_more.push_back(words[word]);
            }
          }
        }
      }
    }
  }
  const auto& frame = shadowView.layoutMetrics.frame;
  op.frame = {
      frame.origin.x, frame.origin.y, frame.size.width, frame.size.height};
  op.layout_changed = mutation.type == ShadowViewMutation::Create ||
      (mutation.type == ShadowViewMutation::Update &&
       mutation.oldChildShadowView.layoutMetrics.frame !=
           mutation.newChildShadowView.layoutMetrics.frame);

  if (mutation.type == ShadowViewMutation::Create ||
      mutation.type == ShadowViewMutation::Update) {
    op.props_changed = mutation.type == ShadowViewMutation::Create ||
        mutation.oldChildShadowView.props !=
            mutation.newChildShadowView.props ||
        mutation.oldChildShadowView.state != mutation.newChildShadowView.state;
    op.view = flattenView(shadowView);
    if (op.component == "Paragraph") {
      op.has_paragraph = true;
      op.paragraph = flattenParagraph(shadowView);
    }
    if (op.component == "TextInput") {
      if (auto state =
              std::dynamic_pointer_cast<const ConcreteState<TextInputState>>(
                  shadowView.state)) {
        op.has_paragraph = true;
        op.paragraph =
            flattenInputText(state->getData().attributedStringBox.getValue());
      }
      // An empty input has no fragment, so the placeholder and the caret would
      // not know the font and color the typed text will have.
      if (op.paragraph.fragments.empty()) {
        if (auto inputProps = std::dynamic_pointer_cast<const TextInputProps>(
                shadowView.props)) {
          op.has_paragraph = true;
          op.paragraph.fragments.push_back(flattenTextFragment(
              inputProps->getEffectiveTextAttributes(1.f), ""));
        }
      }
    }
  }
  return op;
}

namespace {
ParagraphFlat paragraphForMeasure(
    const AttributedString& text,
    const ParagraphAttributes& attributes) {
  ParagraphFlat paragraph = flattenInputText(text);
  if (paragraph.fragments.empty()) {
    paragraph.fragments.push_back(
        flattenTextFragment(text.getBaseTextAttributes(), ""));
    paragraph.measure_empty_line = true;
  }

  // Alignment lives on TextAttributes, not on ParagraphAttributes; the
  // TextAlignment enum values already match the ParagraphFlat encoding.
  const auto& fragments = text.getFragments();
  if (!fragments.empty() && fragments.front().textAttributes.alignment) {
    paragraph.text_align =
        static_cast<uint8_t>(*fragments.front().textAttributes.alignment);
  }
  applyParagraphExtras(paragraph, fragments, attributes);
  paragraph.max_lines = attributes.maximumNumberOfLines;
  switch (attributes.ellipsizeMode) {
    case EllipsizeMode::Clip:
      paragraph.ellipsize = 3;
      break;
    case EllipsizeMode::Head:
      paragraph.ellipsize = 1;
      break;
    case EllipsizeMode::Middle:
      paragraph.ellipsize = 2;
      break;
    case EllipsizeMode::Tail:
      paragraph.ellipsize = 0;
      break;
  }

  return paragraph;
}

GpuiTextSize measureParagraphThroughRust(
    const AttributedString& text,
    const ParagraphAttributes& attributes,
    float maxWidth,
    float maxHeight) {
  const auto result = rn_gpui_measure_text(
      paragraphForMeasure(text, attributes), maxWidth, maxHeight);
  return GpuiTextSize{.width = result.width, .height = result.height};
}

std::vector<GpuiTextLine> measureLinesThroughRust(
    const AttributedString& text,
    const ParagraphAttributes& attributes,
    float maxWidth) {
  std::vector<GpuiTextLine> lines;
  for (const auto& line :
       rn_gpui_measure_lines(paragraphForMeasure(text, attributes), maxWidth)) {
    lines.push_back(GpuiTextLine{
        .text = std::string(line.text),
        .x = line.x,
        .y = line.y,
        .width = line.width,
        .height = line.height,
        .ascender = line.ascender,
        .descender = line.descender,
        .capHeight = line.cap_height,
        .xHeight = line.x_height});
  }
  return lines;
}
} // namespace

void installGpuiTextMeasureTable() {
  setGpuiTextMeasureTable(GpuiTextMeasureTable{
      .measureLines = &measureLinesThroughRust,
      .measureParagraph = &measureParagraphThroughRust});
}
} // namespace rngpui
