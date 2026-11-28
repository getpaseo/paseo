#ifndef BOOST_ALL_NO_LIB
#define BOOST_ALL_NO_LIB 1
#endif
#include "GpuiMarkdownBridge.h"
#include "GpuiModules.h"

#include "CodeBlockHighlighter.hpp"
#include "CodeBlockLanguages.hpp"
#include "MD4CParser.hpp"
#include "MarkdownASTNode.hpp"
#include "TextLinkRecognizer.hpp"

#include <react/renderer/components/EnrichedMarkdownTextSpec/Props.h>

#include <boost/regex.hpp>
#include <folly/dynamic.h>
#include <folly/json.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

std::atomic<RnGpuiMarkdownMeasureFn> gMeasureFn{nullptr};

const char* nodeTypeName(Markdown::NodeType type) {
  using Markdown::NodeType;
  switch (type) {
    case NodeType::Document:
      return "Document";
    case NodeType::Paragraph:
      return "Paragraph";
    case NodeType::Text:
      return "Text";
    case NodeType::Link:
      return "Link";
    case NodeType::Heading:
      return "Heading";
    case NodeType::LineBreak:
      return "LineBreak";
    case NodeType::SoftBreak:
      return "SoftBreak";
    case NodeType::Strong:
      return "Strong";
    case NodeType::Emphasis:
      return "Emphasis";
    case NodeType::Strikethrough:
      return "Strikethrough";
    case NodeType::Underline:
      return "Underline";
    case NodeType::Code:
      return "Code";
    case NodeType::Image:
      return "Image";
    case NodeType::Blockquote:
      return "Blockquote";
    case NodeType::UnorderedList:
      return "UnorderedList";
    case NodeType::OrderedList:
      return "OrderedList";
    case NodeType::ListItem:
      return "ListItem";
    case NodeType::CodeBlock:
      return "CodeBlock";
    case NodeType::ThematicBreak:
      return "ThematicBreak";
    case NodeType::Table:
      return "Table";
    case NodeType::TableHead:
      return "TableHead";
    case NodeType::TableBody:
      return "TableBody";
    case NodeType::TableRow:
      return "TableRow";
    case NodeType::TableHeaderCell:
      return "TableHeaderCell";
    case NodeType::TableCell:
      return "TableCell";
    case NodeType::LatexMathInline:
      return "LatexMathInline";
    case NodeType::LatexMathDisplay:
      return "LatexMathDisplay";
    case NodeType::Spoiler:
      return "Spoiler";
    case NodeType::Superscript:
      return "Superscript";
    case NodeType::Subscript:
      return "Subscript";
    case NodeType::Highlight:
      return "Highlight";
    case NodeType::BlankLine:
      return "BlankLine";
    case NodeType::Admonition:
      return "Admonition";
    case NodeType::Video:
      return "Video";
  }
  return "Unknown";
}

void utf8ToWideWithUtf16Offsets(
    std::string_view utf8,
    std::wstring& wide,
    std::vector<size_t>& utf16ByWideIdx) {
  wide.clear();
  utf16ByWideIdx.clear();
  wide.reserve(utf8.size());
  utf16ByWideIdx.reserve(utf8.size() + 1);

  size_t i = 0;
  size_t u16 = 0;
  const unsigned char* bytes = reinterpret_cast<const unsigned char*>(utf8.data());
  const size_t n = utf8.size();

  auto pushCodepoint = [&](uint32_t cp) {
    uint32_t units = cp > 0xFFFF ? 2u : 1u;
    if constexpr (sizeof(wchar_t) == 2) {
      if (cp <= 0xFFFF) {
        utf16ByWideIdx.push_back(u16);
        wide.push_back(static_cast<wchar_t>(cp));
      } else {
        uint32_t v = cp - 0x10000;
        utf16ByWideIdx.push_back(u16);
        wide.push_back(static_cast<wchar_t>(0xD800 + (v >> 10)));
        utf16ByWideIdx.push_back(u16 + 1);
        wide.push_back(static_cast<wchar_t>(0xDC00 + (v & 0x3FF)));
      }
    } else {
      utf16ByWideIdx.push_back(u16);
      wide.push_back(static_cast<wchar_t>(cp));
    }
    u16 += units;
  };

  while (i < n) {
    unsigned char c = bytes[i];
    if (c < 0x80) {
      pushCodepoint(c);
      i += 1;
    } else if ((c & 0xE0) == 0xC0 && i + 1 < n && (bytes[i + 1] & 0xC0) == 0x80) {
      uint32_t cp = ((c & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
      pushCodepoint(cp);
      i += 2;
    } else if (
        (c & 0xF0) == 0xE0 && i + 2 < n && (bytes[i + 1] & 0xC0) == 0x80 &&
        (bytes[i + 2] & 0xC0) == 0x80) {
      uint32_t cp = ((c & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
      pushCodepoint(cp);
      i += 3;
    } else if (
        (c & 0xF8) == 0xF0 && i + 3 < n && (bytes[i + 1] & 0xC0) == 0x80 &&
        (bytes[i + 2] & 0xC0) == 0x80 && (bytes[i + 3] & 0xC0) == 0x80) {
      uint32_t cp = ((c & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) |
                    ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      pushCodepoint(cp);
      i += 4;
    } else {
      pushCodepoint(0xFFFD);
      i += 1;
    }
  }
  utf16ByWideIdx.push_back(u16);
}

std::vector<size_t> utf16ToUtf8Bytes(std::string_view utf8) {
  std::vector<size_t> bytes;
  bytes.reserve(utf8.size() + 1);
  size_t i = 0;
  const size_t n = utf8.size();
  while (i < n) {
    unsigned char lead = static_cast<unsigned char>(utf8[i]);
    size_t len = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
    if (i + len > n) {
      len = n - i;
    }
    bytes.push_back(i);
    if (len == 4) {
      bytes.push_back(i);
    }
    i += len;
  }
  bytes.push_back(n);
  return bytes;
}

boost::regex_constants::syntax_option_type boostFlagsForJs(bool caseInsensitive, bool dotAll) {
  auto syntax = boost::regex_constants::perl | boost::regex_constants::no_mod_s |
                boost::regex_constants::no_mod_m;
  if (caseInsensitive) {
    syntax |= boost::regex_constants::icase;
  }
  if (dotAll) {
    syntax &= ~boost::regex_constants::no_mod_s;
  }
  return syntax;
}

std::optional<boost::wregex> compileJsRegex(
    std::string_view pattern,
    bool caseInsensitive,
    bool dotAll) {
  if (pattern.empty()) {
    return std::nullopt;
  }
  try {
    std::wstring widePattern;
    std::vector<size_t> dummy;
    utf8ToWideWithUtf16Offsets(pattern, widePattern, dummy);
    return boost::wregex(widePattern, boostFlagsForJs(caseInsensitive, dotAll));
  } catch (...) {
    return std::nullopt;
  }
}

struct HighlightedCodeEntry {
  std::string code;
  std::vector<std::tuple<int64_t, int64_t, int64_t>> tokens;
};

using HighlightMap = std::unordered_map<const Markdown::MarkdownASTNode*, HighlightedCodeEntry>;

std::string extractCodeText(const Markdown::MarkdownASTNode& node) {
  std::string code = node.content;
  if (code.empty() && !node.children.empty()) {
    for (const auto& child : node.children) {
      if (child) {
        code += child->content;
      }
    }
  }
  return code;
}

void collectCodeHighlights(const Markdown::MarkdownASTNode& node, HighlightMap& out) {
  if (node.type == Markdown::NodeType::CodeBlock) {
    std::string code = extractCodeText(node);
    std::string lang;
    if (auto it = node.attributes.find("language"); it != node.attributes.end()) {
      lang = it->second;
    }
    HighlightedCodeEntry entry;
    if (!code.empty()) {
      auto tokens = Markdown::highlightCode(code, lang);
      if (!tokens.empty()) {
        std::vector<size_t> utf16Bytes = utf16ToUtf8Bytes(code);
        entry.tokens.reserve(tokens.size());
        for (const auto& tok : tokens) {
          if (tok.end <= tok.start || tok.end >= utf16Bytes.size()) {
            continue;
          }
          size_t startByte = utf16Bytes[tok.start];
          size_t endByte = utf16Bytes[tok.end];
          if (endByte <= startByte) {
            continue;
          }
          entry.tokens.emplace_back(
              static_cast<int64_t>(startByte),
              static_cast<int64_t>(endByte),
              static_cast<int64_t>(tok.type));
        }
      }
      entry.code = std::move(code);
    }
    out.emplace(&node, std::move(entry));
    return;
  }
  for (const auto& child : node.children) {
    if (child) {
      collectCodeHighlights(*child, out);
    }
  }
}

folly::dynamic astToDynamic(
    const Markdown::MarkdownASTNode& node,
    const std::vector<std::optional<boost::wregex>>& linkVariants,
    const HighlightMap* prehighlighted) {
  folly::dynamic obj = folly::dynamic::object("type", nodeTypeName(node.type));

  if (node.type == Markdown::NodeType::CodeBlock) {
    if (prehighlighted != nullptr) {
      if (auto it = prehighlighted->find(&node); it != prehighlighted->end()) {
        if (!it->second.code.empty()) {
          obj["content"] = it->second.code;
        }
        if (!it->second.tokens.empty()) {
          folly::dynamic tokArr = folly::dynamic::array();
          for (const auto& [s, e, t] : it->second.tokens) {
            tokArr.push_back(folly::dynamic::array(s, e, t));
          }
          obj["tokens"] = std::move(tokArr);
        }
      }
    } else {
      std::string code = extractCodeText(node);
      if (!code.empty()) {
        obj["content"] = code;
        std::string lang;
        if (auto it = node.attributes.find("language"); it != node.attributes.end()) {
          lang = it->second;
        }
        auto tokens = Markdown::highlightCode(code, lang);
        if (!tokens.empty()) {
          std::vector<size_t> utf16Bytes = utf16ToUtf8Bytes(code);
          folly::dynamic tokArr = folly::dynamic::array();
          for (const auto& tok : tokens) {
            if (tok.end <= tok.start || tok.end >= utf16Bytes.size()) {
              continue;
            }
            size_t startByte = utf16Bytes[tok.start];
            size_t endByte = utf16Bytes[tok.end];
            if (endByte <= startByte) {
              continue;
            }
            tokArr.push_back(folly::dynamic::array(
                static_cast<int64_t>(startByte),
                static_cast<int64_t>(endByte),
                static_cast<int64_t>(tok.type)));
          }
          if (!tokArr.empty()) {
            obj["tokens"] = std::move(tokArr);
          }
        }
      }
    }
  } else if (!node.content.empty()) {
    obj["content"] = node.content;
  }

  if (!node.attributes.empty() || node.type == Markdown::NodeType::CodeBlock) {
    folly::dynamic attrs = folly::dynamic::object();
    for (const auto& [k, v] : node.attributes) {
      attrs[k] = v;
    }
    if (node.type == Markdown::NodeType::CodeBlock) {
      if (auto it = node.attributes.find("language"); it != node.attributes.end() && !it->second.empty()) {
        std::string display = Markdown::displayNameForLanguage(it->second);
        if (!display.empty()) {
          attrs["displayLanguage"] = std::move(display);
        }
      }
    }
    if (node.type == Markdown::NodeType::Link && !linkVariants.empty()) {
      if (auto it = node.attributes.find("url"); it != node.attributes.end() && !it->second.empty()) {
        std::wstring wideUrl;
        std::vector<size_t> dummy;
        utf8ToWideWithUtf16Offsets(it->second, wideUrl, dummy);
        for (size_t idx = 0; idx < linkVariants.size(); idx++) {
          if (!linkVariants[idx]) {
            continue;
          }
          try {
            boost::wsmatch m;
            if (boost::regex_search(wideUrl, m, *linkVariants[idx])) {
              attrs["linkVariant"] = std::to_string(idx);
              break;
            }
          } catch (...) {
          }
        }
      }
    }
    if (!attrs.empty()) {
      obj["attributes"] = std::move(attrs);
    }
  }

  if (!node.children.empty() && node.type != Markdown::NodeType::CodeBlock) {
    folly::dynamic children = folly::dynamic::array();
    for (const auto& child : node.children) {
      if (child) {
        children.push_back(astToDynamic(*child, linkVariants, prehighlighted));
      }
    }
    obj["children"] = std::move(children);
  }

  return obj;
}

uint32_t colorInt(const facebook::react::SharedColor& color) {
  return color ? rngpui::argb(color) : 0u;
}

template <typename BlockT>
folly::dynamic baseBlockToDynamic(const BlockT& s) {
  folly::dynamic o = folly::dynamic::object();
  o["fontSize"] = s.fontSize;
  o["fontFamily"] = s.fontFamily;
  o["fontWeight"] = s.fontWeight;
  o["color"] = static_cast<int64_t>(colorInt(s.color));
  o["marginTop"] = s.marginTop;
  o["marginBottom"] = s.marginBottom;
  o["lineHeight"] = s.lineHeight;
  if constexpr (requires { s.textAlign; }) {
    o["textAlign"] = s.textAlign;
  }
  return o;
}

template <typename PropsT>
folly::dynamic styleToDynamic(const PropsT& props) {
  const auto& st = props.markdownStyle;
  folly::dynamic out = folly::dynamic::object();

  out["paragraph"] = baseBlockToDynamic(st.paragraph);
  out["h1"] = baseBlockToDynamic(st.h1);
  out["h2"] = baseBlockToDynamic(st.h2);
  out["h3"] = baseBlockToDynamic(st.h3);
  out["h4"] = baseBlockToDynamic(st.h4);
  out["h5"] = baseBlockToDynamic(st.h5);
  out["h6"] = baseBlockToDynamic(st.h6);

  {
    auto bq = baseBlockToDynamic(st.blockquote);
    bq["borderColor"] = static_cast<int64_t>(colorInt(st.blockquote.borderColor));
    bq["borderWidth"] = st.blockquote.borderWidth;
    bq["gapWidth"] = st.blockquote.gapWidth;
    bq["backgroundColor"] = static_cast<int64_t>(colorInt(st.blockquote.backgroundColor));
    bq["borderRadius"] = st.blockquote.borderRadius;
    bq["padding"] = st.blockquote.padding;
    folly::dynamic adm = folly::dynamic::object();
    auto putAdm = [&](const char* key, const auto& item) {
      adm[key] = folly::dynamic::object(
          "color", static_cast<int64_t>(colorInt(item.color)))(
          "backgroundColor", static_cast<int64_t>(colorInt(item.backgroundColor)));
    };
    putAdm("note", st.blockquote.admonitions.note);
    putAdm("tip", st.blockquote.admonitions.tip);
    putAdm("important", st.blockquote.admonitions.important);
    putAdm("warning", st.blockquote.admonitions.warning);
    putAdm("caution", st.blockquote.admonitions.caution);
    bq["admonitions"] = std::move(adm);
    out["blockquote"] = std::move(bq);
  }

  {
    auto ls = baseBlockToDynamic(st.list);
    ls["bulletColor"] = static_cast<int64_t>(colorInt(st.list.bulletColor));
    ls["bulletSize"] = st.list.bulletSize;
    ls["markerMinWidth"] = st.list.markerMinWidth;
    ls["markerColor"] = static_cast<int64_t>(colorInt(st.list.markerColor));
    ls["markerFontWeight"] = st.list.markerFontWeight;
    ls["gapWidth"] = st.list.gapWidth;
    ls["marginLeft"] = st.list.marginLeft;
    ls["itemSpacing"] = st.list.itemSpacing;
    out["list"] = std::move(ls);
  }

  {
    auto cb = baseBlockToDynamic(st.codeBlock);
    cb["backgroundColor"] = static_cast<int64_t>(colorInt(st.codeBlock.backgroundColor));
    cb["borderColor"] = static_cast<int64_t>(colorInt(st.codeBlock.borderColor));
    cb["borderRadius"] = st.codeBlock.borderRadius;
    cb["borderWidth"] = st.codeBlock.borderWidth;
    cb["padding"] = st.codeBlock.padding;
    const auto& sc = st.codeBlock.syntaxColors;
    cb["syntaxColors"] = folly::dynamic::object(
        "keyword", static_cast<int64_t>(colorInt(sc.keyword)))(
        "operatorColor", static_cast<int64_t>(colorInt(sc.operatorColor)))(
        "punctuation", static_cast<int64_t>(colorInt(sc.punctuation)))(
        "string", static_cast<int64_t>(colorInt(sc.string)))(
        "number", static_cast<int64_t>(colorInt(sc.number)))(
        "constant", static_cast<int64_t>(colorInt(sc.constant)))(
        "comment", static_cast<int64_t>(colorInt(sc.comment)))(
        "function", static_cast<int64_t>(colorInt(sc.function)))(
        "type", static_cast<int64_t>(colorInt(sc.type)))(
        "variable", static_cast<int64_t>(colorInt(sc.variable)))(
        "property", static_cast<int64_t>(colorInt(sc.property)))(
        "tag", static_cast<int64_t>(colorInt(sc.tag)))(
        "attribute", static_cast<int64_t>(colorInt(sc.attribute)))(
        "embedded", static_cast<int64_t>(colorInt(sc.embedded)));
    out["codeBlock"] = std::move(cb);
  }

  out["link"] = folly::dynamic::object(
      "fontFamily", st.link.fontFamily)(
      "color", static_cast<int64_t>(colorInt(st.link.color)))(
      "underline", st.link.underline)(
      "backgroundColor", static_cast<int64_t>(colorInt(st.link.backgroundColor)));

  out["strong"] = folly::dynamic::object(
      "fontFamily", st.strong.fontFamily)(
      "fontWeight", st.strong.fontWeight)(
      "color", static_cast<int64_t>(colorInt(st.strong.color)));

  out["em"] = folly::dynamic::object(
      "fontFamily", st.em.fontFamily)(
      "fontStyle", st.em.fontStyle)(
      "color", static_cast<int64_t>(colorInt(st.em.color)));

  out["strikethrough"] = folly::dynamic::object(
      "color", static_cast<int64_t>(colorInt(st.strikethrough.color)));

  out["underline"] = folly::dynamic::object(
      "color", static_cast<int64_t>(colorInt(st.underline.color)));

  out["code"] = folly::dynamic::object(
      "fontFamily", st.code.fontFamily)(
      "fontSize", st.code.fontSize)(
      "fontScale", st.code.fontScale)(
      "color", static_cast<int64_t>(colorInt(st.code.color)))(
      "backgroundColor", static_cast<int64_t>(colorInt(st.code.backgroundColor)))(
      "borderColor", static_cast<int64_t>(colorInt(st.code.borderColor)));

  out["image"] = folly::dynamic::object(
      "height", st.image.height)(
      "maxHeight", st.image.maxHeight)(
      "aspectRatio", st.image.aspectRatio)(
      "resizeMode", st.image.resizeMode)(
      "borderRadius", st.image.borderRadius)(
      "marginTop", st.image.marginTop)(
      "marginBottom", st.image.marginBottom);

  out["inlineImage"] = folly::dynamic::object("size", st.inlineImage.size);

  out["thematicBreak"] = folly::dynamic::object(
      "color", static_cast<int64_t>(colorInt(st.thematicBreak.color)))(
      "height", st.thematicBreak.height)(
      "marginTop", st.thematicBreak.marginTop)(
      "marginBottom", st.thematicBreak.marginBottom);

  {
    auto tb = baseBlockToDynamic(st.table);
    tb["headerFontFamily"] = st.table.headerFontFamily;
    tb["headerBackgroundColor"] = static_cast<int64_t>(colorInt(st.table.headerBackgroundColor));
    tb["headerTextColor"] = static_cast<int64_t>(colorInt(st.table.headerTextColor));
    tb["rowEvenBackgroundColor"] = static_cast<int64_t>(colorInt(st.table.rowEvenBackgroundColor));
    tb["rowOddBackgroundColor"] = static_cast<int64_t>(colorInt(st.table.rowOddBackgroundColor));
    tb["borderColor"] = static_cast<int64_t>(colorInt(st.table.borderColor));
    tb["borderWidth"] = st.table.borderWidth;
    tb["borderRadius"] = st.table.borderRadius;
    tb["cellPaddingHorizontal"] = st.table.cellPaddingHorizontal;
    tb["cellPaddingVertical"] = st.table.cellPaddingVertical;
    tb["horizontalOverflow"] = st.table.horizontalOverflow;
    tb["align"] = st.table.align;
    out["table"] = std::move(tb);
  }

  out["taskList"] = folly::dynamic::object(
      "checkedColor", static_cast<int64_t>(colorInt(st.taskList.checkedColor)))(
      "borderColor", static_cast<int64_t>(colorInt(st.taskList.borderColor)))(
      "checkboxSize", st.taskList.checkboxSize)(
      "checkboxBorderRadius", st.taskList.checkboxBorderRadius)(
      "checkmarkColor", static_cast<int64_t>(colorInt(st.taskList.checkmarkColor)))(
      "checkedTextColor", static_cast<int64_t>(colorInt(st.taskList.checkedTextColor)))(
      "checkedStrikethrough", st.taskList.checkedStrikethrough);

  out["highlight"] = folly::dynamic::object(
      "color", static_cast<int64_t>(colorInt(st.highlight.color)))(
      "backgroundColor", static_cast<int64_t>(colorInt(st.highlight.backgroundColor)));

  if (!st.linkVariants.empty()) {
    folly::dynamic variants = folly::dynamic::array();
    for (const auto& entry : st.linkVariants) {
      variants.push_back(folly::dynamic::object(
          "pattern", entry.pattern)(
          "color", static_cast<int64_t>(colorInt(entry.color)))(
          "underline", entry.underline)(
          "backgroundColor", static_cast<int64_t>(colorInt(entry.backgroundColor)))(
          "fontFamily", entry.fontFamily));
    }
    out["linkVariants"] = std::move(variants);
  }

  return out;
}

class SnapshotCache {
public:
  std::shared_ptr<const std::string> get(const std::string& key) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
      return nullptr;
    }
    return it->second;
  }

  void put(const std::string& key, std::shared_ptr<const std::string> value) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (entries_.find(key) != entries_.end()) {
      entries_[key] = std::move(value);
      return;
    }
    if (order_.size() >= kMaxEntries) {
      entries_.erase(order_.front());
      order_.pop_front();
    }
    order_.push_back(key);
    entries_.emplace(key, std::move(value));
  }

private:
  static constexpr size_t kMaxEntries = 128;
  std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<const std::string>> entries_;
  std::deque<std::string> order_;
};

SnapshotCache& snapshotCache() {
  static SnapshotCache cache;
  return cache;
}

template <typename PropsT>
std::shared_ptr<const std::string> buildSnapshotJson(
    const PropsT& props,
    bool isMarkdownContainer) {
  folly::dynamic styleDyn = styleToDynamic(props);
  std::string styleJson = folly::toJson(styleDyn);

  bool isGFM = isMarkdownContainer ? true : props.isGFM;
  std::string key;
  key.reserve(props.markdown.size() + styleJson.size() + 64);
  key.append(props.markdown);
  key.push_back('\0');
  key.push_back(isGFM ? '1' : '0');
  key.push_back(props.allowTrailingMargin ? '1' : '0');
  key.push_back(props.selectable ? '1' : '0');
  key.push_back(props.enableImagePress ? '1' : '0');
  key.push_back(props.enableCodeBlockPress ? '1' : '0');
  key.push_back(props.enableTaskListItemToggle ? '1' : '0');
  key.push_back(props.md4cFlags.underline ? '1' : '0');
  key.push_back(props.md4cFlags.superscript ? '1' : '0');
  key.push_back(props.md4cFlags.subscript ? '1' : '0');
  key.push_back(props.md4cFlags.highlight ? '1' : '0');
  key.push_back(props.md4cFlags.admonitions ? '1' : '0');
  key.push_back(props.md4cFlags.hardSoftBreaks ? '1' : '0');
  key.push_back(props.md4cFlags.latexMath ? '1' : '0');
  key.push_back(props.md4cFlags.preserveBlankLines ? '1' : '0');
  key.push_back('\0');
  key.append(std::to_string(props.numberOfLines));
  key.push_back('\0');
  key.append(props.linkRecognition.text.pattern);
  key.push_back(props.linkRecognition.text.caseInsensitive ? '1' : '0');
  key.push_back(props.linkRecognition.text.dotAll ? '1' : '0');
  key.push_back(props.linkRecognition.text.isDisabled ? '1' : '0');
  key.push_back(props.linkRecognition.text.isDefault ? '1' : '0');
  key.push_back('\0');
  key.append(props.linkRecognition.inlineCode.pattern);
  key.push_back(props.linkRecognition.inlineCode.caseInsensitive ? '1' : '0');
  key.push_back(props.linkRecognition.inlineCode.dotAll ? '1' : '0');
  key.push_back(props.linkRecognition.inlineCode.isDisabled ? '1' : '0');
  key.push_back(props.linkRecognition.inlineCode.isDefault ? '1' : '0');
  key.push_back('\0');
  key.append(styleJson);

  if (auto cached = snapshotCache().get(key)) {
    return cached;
  }

  Markdown::Md4cFlags mdFlags;
  mdFlags.underline = props.md4cFlags.underline;
  mdFlags.superscript = props.md4cFlags.superscript;
  mdFlags.subscript = props.md4cFlags.subscript;
  mdFlags.highlight = props.md4cFlags.highlight;
  mdFlags.admonitions = props.md4cFlags.admonitions;
  mdFlags.permissiveAutolinks = !props.linkRecognition.text.isDisabled;
  mdFlags.hardSoftBreaks = props.md4cFlags.hardSoftBreaks;
  mdFlags.latexMath = props.md4cFlags.latexMath;
  mdFlags.preserveBlankLines = props.md4cFlags.preserveBlankLines;

  Markdown::MD4CParser parser;
  auto ast = parser.parse(props.markdown, mdFlags, isGFM);

  const bool textActive = !props.linkRecognition.text.isDisabled &&
                          !props.linkRecognition.text.isDefault &&
                          !props.linkRecognition.text.pattern.empty();
  const bool codeActive = !props.linkRecognition.inlineCode.isDisabled &&
                          !props.linkRecognition.inlineCode.isDefault &&
                          !props.linkRecognition.inlineCode.pattern.empty();

  if (ast && (textActive || codeActive)) {
    auto textRegex = textActive
                         ? compileJsRegex(
                               props.linkRecognition.text.pattern,
                               props.linkRecognition.text.caseInsensitive,
                               props.linkRecognition.text.dotAll)
                         : std::nullopt;
    auto codeRegex = codeActive
                         ? compileJsRegex(
                               props.linkRecognition.inlineCode.pattern,
                               props.linkRecognition.inlineCode.caseInsensitive,
                               props.linkRecognition.inlineCode.dotAll)
                         : std::nullopt;
    if (textRegex || codeRegex) {
      Markdown::TextLinkMatchers matchers;
      if (textRegex) {
        matchers.text = [&textRegex](const std::vector<std::string_view>& runs) {
          std::vector<std::vector<Markdown::TextRange>> out;
          out.reserve(runs.size());
          std::wstring wide;
          std::vector<size_t> utf16Map;
          for (std::string_view run : runs) {
            std::vector<Markdown::TextRange> matches;
            if (!run.empty()) {
              utf8ToWideWithUtf16Offsets(run, wide, utf16Map);
              try {
                boost::wsregex_iterator it(wide.begin(), wide.end(), *textRegex);
                boost::wsregex_iterator end;
                size_t lastEnd = 0;
                for (; it != end; ++it) {
                  if ((*it).length() <= 0) {
                    continue;
                  }
                  size_t ws = static_cast<size_t>((*it).position());
                  size_t we = ws + static_cast<size_t>((*it).length());
                  if (ws >= utf16Map.size() || we >= utf16Map.size()) {
                    continue;
                  }
                  size_t u16Start = utf16Map[ws];
                  size_t u16End = utf16Map[we];
                  if (u16Start >= lastEnd && u16End > u16Start) {
                    matches.push_back({u16Start, u16End});
                    lastEnd = u16End;
                  }
                }
              } catch (...) {
              }
            }
            out.push_back(std::move(matches));
          }
          return out;
        };
      }
      if (codeRegex) {
        matchers.inlineCode = [&codeRegex](const std::vector<std::string_view>& spans) {
          std::vector<uint8_t> out(spans.size(), 0);
          std::wstring wide;
          std::vector<size_t> utf16Map;
          for (size_t idx = 0; idx < spans.size(); idx++) {
            if (spans[idx].empty()) {
              continue;
            }
            utf8ToWideWithUtf16Offsets(spans[idx], wide, utf16Map);
            try {
              boost::wsmatch m;
              if (boost::regex_search(wide, m, *codeRegex) && m.length() > 0) {
                out[idx] = 1;
              }
            } catch (...) {
            }
          }
          return out;
        };
      }
      Markdown::recognizeTextLinks(*ast, matchers);
    }
  }

  std::vector<std::optional<boost::wregex>> variantRegexes;
  variantRegexes.reserve(props.markdownStyle.linkVariants.size());
  for (const auto& entry : props.markdownStyle.linkVariants) {
    variantRegexes.push_back(compileJsRegex(entry.pattern, false, false));
  }

  folly::dynamic snapshot = folly::dynamic::object();
  if (ast) {
    snapshot["ast"] = astToDynamic(*ast, variantRegexes, nullptr);
  } else {
    snapshot["ast"] = folly::dynamic::object("type", "Document");
  }
  snapshot["style"] = std::move(styleDyn);
  snapshot["isGFM"] = isGFM;
  snapshot["allowTrailingMargin"] = props.allowTrailingMargin;
  snapshot["selectable"] = props.selectable;
  snapshot["enableImagePress"] = props.enableImagePress;
  snapshot["enableCodeBlockPress"] = props.enableCodeBlockPress;
  snapshot["enableTaskListItemToggle"] = props.enableTaskListItemToggle;
  snapshot["numberOfLines"] = isGFM ? 0 : props.numberOfLines;
  snapshot["writingDirection"] = props.writingDirection;

  auto encoded = std::make_shared<std::string>(folly::toJson(snapshot));
  snapshotCache().put(key, encoded);
  return encoded;
}

template <typename PropsT>
facebook::react::Size measureMarkdownImpl(
    const PropsT& props,
    bool isMarkdownContainer,
    float maxWidth,
    float maxHeight) {
  auto json = buildSnapshotJson(props, isMarkdownContainer);
  auto fn = gMeasureFn.load(std::memory_order_acquire);
  if (!fn) {
    return {0.0f, 0.0f};
  }
  float width = std::isfinite(maxWidth) ? maxWidth : std::numeric_limits<float>::infinity();
  float height = std::isfinite(maxHeight) ? maxHeight : std::numeric_limits<float>::infinity();
  float outW = 0.0f;
  float outH = 0.0f;
  fn(json->c_str(), width, height, &outW, &outH);
  return {outW, outH};
}

} // namespace

extern "C" void rn_gpui_markdown_set_measure_fn(RnGpuiMarkdownMeasureFn fn) {
  gMeasureFn.store(fn, std::memory_order_release);
}

extern "C" int rn_gpui_markdown_bench_stages(
    const char* markdown,
    bool is_gfm,
    const char* style_json,
    double* out_parse_ns,
    double* out_highlight_ns,
    double* out_serialize_ns,
    char** out_json,
    size_t* out_json_len) {
  if (!markdown || !style_json) {
    return 1;
  }
  using clock = std::chrono::steady_clock;

  Markdown::Md4cFlags mdFlags;
  mdFlags.admonitions = is_gfm;
  mdFlags.hardSoftBreaks = true;

  auto t0 = clock::now();
  Markdown::MD4CParser parser;
  auto ast = parser.parse(std::string(markdown), mdFlags, is_gfm);
  auto t1 = clock::now();

  HighlightMap highlights;
  if (ast) {
    collectCodeHighlights(*ast, highlights);
  }
  auto t2 = clock::now();

  folly::dynamic styleDyn = folly::parseJson(style_json);
  std::vector<std::optional<boost::wregex>> noVariants;
  folly::dynamic snapshot = folly::dynamic::object();
  snapshot["ast"] = ast ? astToDynamic(*ast, noVariants, &highlights)
                        : folly::dynamic::object("type", "Document");
  snapshot["style"] = std::move(styleDyn);
  snapshot["isGFM"] = is_gfm;
  snapshot["allowTrailingMargin"] = false;
  snapshot["selectable"] = true;
  snapshot["enableImagePress"] = false;
  snapshot["enableCodeBlockPress"] = false;
  snapshot["enableTaskListItemToggle"] = false;
  snapshot["numberOfLines"] = 0;
  std::string encoded = folly::toJson(snapshot);
  auto t3 = clock::now();

  if (out_parse_ns) {
    *out_parse_ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
  }
  if (out_highlight_ns) {
    *out_highlight_ns = std::chrono::duration<double, std::nano>(t2 - t1).count();
  }
  if (out_serialize_ns) {
    *out_serialize_ns = std::chrono::duration<double, std::nano>(t3 - t2).count();
  }
  if (out_json && out_json_len) {
    char* buf = static_cast<char*>(std::malloc(encoded.size() + 1));
    if (!buf) {
      return 2;
    }
    std::memcpy(buf, encoded.data(), encoded.size());
    buf[encoded.size()] = '\0';
    *out_json = buf;
    *out_json_len = encoded.size();
  }
  return 0;
}

extern "C" void rn_gpui_markdown_bench_free(char* ptr) {
  std::free(ptr);
}

namespace rngpui::markdown {

std::string serializePropsJson(
    const facebook::react::EnrichedMarkdownProps& props,
    bool isMarkdownContainer) {
  return *buildSnapshotJson(props, isMarkdownContainer);
}

std::string serializePropsJson(
    const facebook::react::EnrichedMarkdownTextProps& props,
    bool isMarkdownContainer) {
  return *buildSnapshotJson(props, isMarkdownContainer);
}

facebook::react::Size measureMarkdown(
    const facebook::react::EnrichedMarkdownProps& props,
    bool isMarkdownContainer,
    float maxWidth,
    float maxHeight) {
  return measureMarkdownImpl(props, isMarkdownContainer, maxWidth, maxHeight);
}

facebook::react::Size measureMarkdown(
    const facebook::react::EnrichedMarkdownTextProps& props,
    bool isMarkdownContainer,
    float maxWidth,
    float maxHeight) {
  return measureMarkdownImpl(props, isMarkdownContainer, maxWidth, maxHeight);
}

} // namespace rngpui::markdown
