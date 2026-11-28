#if LOOM_RENDERER

#include "LoomComponentProps.h"

#include "MountBatchBuilder.h"

#include <react/renderer/components/image/conversions.h>
#include <react/renderer/components/scrollview/conversions.h>
#include <react/renderer/components/textinput/baseConversions.h>
#include <react/renderer/components/view/conversions.h>
#include <react/renderer/core/RawValue.h>
#include <react/renderer/core/propsConversions.h>

#include <glog/logging.h>

#include <cmath>
#include <cstdio>
#include <limits>
#include <optional>

namespace rngpui {

using namespace facebook::react;

void JsonBody::begin(const char* key) {
  if (!body_.empty()) {
    body_ += ',';
  }
  body_ += '"';
  body_ += key;
  body_ += "\":";
}

void JsonBody::number(const char* key, double value) {
  begin(key);
  if (!std::isfinite(value)) {
    body_ += '0';
    return;
  }
  char text[40];
  if (value == std::floor(value) && std::fabs(value) < 1e15) {
    std::snprintf(text, sizeof(text), "%lld", static_cast<long long>(value));
  } else {
    std::snprintf(text, sizeof(text), "%.9g", value);
  }
  body_ += text;
}

void JsonBody::boolean(const char* key, bool value) {
  begin(key);
  body_ += value ? "true" : "false";
}

void JsonBody::string(const char* key, const std::string& value) {
  begin(key);
  body_ += '"';
  for (const unsigned char byte : value) {
    switch (byte) {
      case '"':
        body_ += "\\\"";
        break;
      case '\\':
        body_ += "\\\\";
        break;
      case '\n':
        body_ += "\\n";
        break;
      case '\r':
        body_ += "\\r";
        break;
      case '\t':
        body_ += "\\t";
        break;
      default:
        if (byte < 0x20) {
          char escaped[8];
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", byte);
          body_ += escaped;
        } else {
          body_ += static_cast<char>(byte);
        }
    }
  }
  body_ += '"';
}

std::string closeJson(const std::string& body, const std::string& extra) {
  std::string json = "{" + body;
  if (!extra.empty()) {
    if (!body.empty()) {
      json += ',';
    }
    json += extra;
  }
  json += '}';
  return json;
}

namespace {

const folly::dynamic* find(const folly::dynamic& props, const char* key) {
  if (!props.isObject()) {
    return nullptr;
  }
  const auto* value = props.get_ptr(key);
  return value == nullptr || value->isNull() ? nullptr : value;
}

template <class T>
T read(
    const PropsParserContext& context,
    const folly::dynamic& props,
    const char* key,
    T fallback) {
  const auto* value = find(props, key);
  if (value == nullptr) {
    return fallback;
  }
  try {
    T result = fallback;
    fromRawValue(context, RawValue(*value), result);
    return result;
  } catch (const std::exception& error) {
    LOG(ERROR) << "Loom: cannot convert " << key << ": " << error.what();
    return fallback;
  }
}

// UTF-16 units of `text`, the unit the JavaScript selection is in.
int32_t utf16Length(const std::string& text) {
  int32_t units = 0;
  for (const unsigned char byte : text) {
    if ((byte & 0xC0) != 0x80) {
      units += byte >= 0xF0 ? 2 : 1;
    }
  }
  return units;
}

} // namespace

LoomImage parseLoomImage(
    const PropsParserContext& context,
    const folly::dynamic& props) {
  LoomImage image;
  image.sources = read<std::vector<ImageSource>>(context, props, "source", {});
  image.blurRadius = read<Float>(context, props, "blurRadius", 0.f);
  JsonBody json;
  if (!image.sources.empty()) {
    json.string("uri", image.sources[0].uri);
  }
  switch (read<ImageResizeMode>(
      context, props, "resizeMode", ImageResizeMode::Stretch)) {
    case ImageResizeMode::Contain:
      json.string("resizeMode", "contain");
      break;
    case ImageResizeMode::Cover:
      json.string("resizeMode", "cover");
      break;
    case ImageResizeMode::Center:
      json.string("resizeMode", "center");
      break;
    case ImageResizeMode::Repeat:
      json.string("resizeMode", "repeat");
      break;
    case ImageResizeMode::None:
      json.string("resizeMode", "none");
      break;
    default:
      json.string("resizeMode", "stretch");
      break;
  }
  json.number(
      "tintColor",
      argb(read<SharedColor>(context, props, "tintColor", SharedColor{})));
  json.number("blurRadius", image.blurRadius);
  const auto defaultSource =
      read<ImageSource>(context, props, "defaultSource", ImageSource{});
  if (!defaultSource.uri.empty()) {
    json.string("defaultSource", defaultSource.uri);
  }
  image.body = json.body();
  return image;
}

std::string parseLoomScrollView(
    const PropsParserContext& context,
    const folly::dynamic& props) {
  JsonBody json;
  const bool horizontal = read<bool>(context, props, "horizontal", false);
  const bool vertical =
      read<bool>(context, props, "showsVerticalScrollIndicator", true);
  const bool horizontalIndicator =
      read<bool>(context, props, "showsHorizontalScrollIndicator", true);
  if (const auto* maintain = find(props, "maintainVisibleContentPosition")) {
    try {
      ScrollViewMaintainVisibleContentPosition position;
      fromRawValue(context, RawValue(*maintain), position);
      json.number("maintainMinIndex", position.minIndexForVisible);
      if (position.autoscrollToTopThreshold) {
        json.number(
            "maintainAutoscrollThreshold", *position.autoscrollToTopThreshold);
      }
    } catch (const std::exception& error) {
      LOG(ERROR) << "Loom: cannot convert maintainVisibleContentPosition: "
                 << error.what();
    }
  }
  json.number(
      "decelerationRate",
      read<Float>(context, props, "decelerationRate", 0.998f));
  json.number(
      "scrollEventThrottle",
      read<Float>(context, props, "scrollEventThrottle", 0.f));
  json.boolean(
      "pagingEnabled", read<bool>(context, props, "pagingEnabled", false));
  json.number(
      "snapToInterval", read<Float>(context, props, "snapToInterval", 0.f));
  json.boolean("snapToStart", read<bool>(context, props, "snapToStart", true));
  json.boolean("snapToEnd", read<bool>(context, props, "snapToEnd", true));
  json.boolean(
      "disableIntervalMomentum",
      read<bool>(context, props, "disableIntervalMomentum", false));
  std::string offsets = "[";
  for (const auto offset :
       read<std::vector<Float>>(context, props, "snapToOffsets", {})) {
    if (offsets.size() > 1) {
      offsets += ',';
    }
    char text[40];
    std::snprintf(text, sizeof(text), "%.9g", static_cast<double>(offset));
    offsets += text;
  }
  offsets += ']';
  std::string body = json.body();
  body += ",\"snapToOffsets\":" + offsets;
  JsonBody tail;
  switch (read<ScrollViewSnapToAlignment>(
      context, props, "snapToAlignment", ScrollViewSnapToAlignment::Start)) {
    case ScrollViewSnapToAlignment::Center:
      tail.string("snapToAlignment", "center");
      break;
    case ScrollViewSnapToAlignment::End:
      tail.string("snapToAlignment", "end");
      break;
    default:
      tail.string("snapToAlignment", "start");
      break;
  }
  tail.boolean("horizontal", horizontal);
  tail.boolean("enabled", read<bool>(context, props, "scrollEnabled", true));
  tail.boolean("indicator", horizontal ? horizontalIndicator : vertical);
  body += "," + tail.body();
  return body;
}

LoomTextInput parseLoomTextInput(
    const PropsParserContext& context,
    const folly::dynamic& props) {
  LoomTextInput input;
  JsonBody json;
  const auto text = read<std::string>(context, props, "text", "");
  json.string("text", text);
  json.string(
      "placeholder", read<std::string>(context, props, "placeholder", ""));
  json.number(
      "selectionColor",
      argb(read<SharedColor>(context, props, "selectionColor", SharedColor{})));
  json.boolean("multiline", read<bool>(context, props, "multiline", false));
  json.number(
      "placeholderTextColor",
      argb(read<SharedColor>(
          context, props, "placeholderTextColor", SharedColor{})));
  std::string submit = "default";
  if (const auto* value = find(props, "submitBehavior")) {
    if (value->isString()) {
      const auto& name = value->getString();
      if (name == "submit" || name == "blurAndSubmit" || name == "newline") {
        submit = name;
      }
    }
  }
  json.string("submitBehavior", submit);
  const auto maxLength =
      read<int>(context, props, "maxLength", std::numeric_limits<int>::max());
  if (maxLength != std::numeric_limits<int>::max()) {
    json.number("maxLength", maxLength);
  }
  json.boolean(
      "contextMenuHidden",
      read<bool>(context, props, "contextMenuHidden", false));
  json.boolean("caretHidden", read<bool>(context, props, "caretHidden", false));
  json.boolean(
      "selectTextOnFocus",
      read<bool>(context, props, "selectTextOnFocus", false));
  json.boolean(
      "editable",
      read<bool>(context, props, "editable", true) &&
          !read<bool>(context, props, "readOnly", false));
  json.boolean("secure", read<bool>(context, props, "secureTextEntry", false));
  input.eventCount = read<int64_t>(context, props, "mostRecentEventCount", 0);
  json.number("eventCount", static_cast<double>(input.eventCount));
  int32_t start = 0;
  int32_t end = 0;
  bool selectionSet = false;
  if (const auto* selection = find(props, "selection")) {
    if (selection->isObject()) {
      const auto* from = selection->get_ptr("start");
      const auto* to = selection->get_ptr("end");
      if (from != nullptr && from->isNumber()) {
        start = static_cast<int32_t>(from->asInt());
        selectionSet = true;
      }
      if (to != nullptr && to->isNumber()) {
        end = static_cast<int32_t>(to->asInt());
        selectionSet = true;
      }
    }
  }
  json.boolean("selectionSet", selectionSet);
  if (!selectionSet) {
    start = end = utf16Length(text);
  }
  json.number("selectionStart", start);
  json.number("selectionEnd", end);
  input.body = json.body();
  return input;
}

bool parseLoomModalVisible(const folly::dynamic& props) {
  const auto* visible = find(props, "visible");
  return visible == nullptr || !visible->isBool() || visible->asBool();
}

} // namespace rngpui

#endif // LOOM_RENDERER
