// The props of the built-in components that carry more than view props
// (Image, ScrollView, TextInput, Modal), read from Loom's raw props into the
// JSON the Rust renderer reads and the few typed values the host needs.
#pragma once

#if LOOM_RENDERER

#include <react/renderer/components/image/ImageProps.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/graphics/Size.h>

#include <folly/dynamic.h>

#include <cstdint>
#include <string>
#include <vector>

namespace rngpui {

/// A JSON object assembled key by key; `body` is what lies between the braces.
class JsonBody {
 public:
  void number(const char* key, double value);
  void boolean(const char* key, bool value);
  void string(const char* key, const std::string& value);
  const std::string& body() const {
    return body_;
  }

 private:
  void begin(const char* key);
  std::string body_;
};

struct LoomImage {
  std::vector<facebook::react::ImageSource> sources;
  float blurRadius{0};
  std::string body;
};

struct LoomTextInput {
  std::string body;
  int64_t eventCount{0};
};

LoomImage parseLoomImage(
    const facebook::react::PropsParserContext& context,
    const folly::dynamic& props);
std::string parseLoomScrollView(
    const facebook::react::PropsParserContext& context,
    const folly::dynamic& props);
LoomTextInput parseLoomTextInput(
    const facebook::react::PropsParserContext& context,
    const folly::dynamic& props);
/// Whether a Modal is visible (`true` when the prop is absent).
bool parseLoomModalVisible(const folly::dynamic& props);

/// `{` + body + extra + `}`.
std::string closeJson(const std::string& body, const std::string& extra);

} // namespace rngpui

#endif // LOOM_RENDERER
