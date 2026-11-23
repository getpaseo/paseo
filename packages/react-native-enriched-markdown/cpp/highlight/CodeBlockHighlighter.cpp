#include "CodeBlockHighlighter.hpp"

// Stub compiled when the syntax highlighting module is disabled. The real
// implementation defines the same symbol under ENRICHED_MARKDOWN_CODE_HIGHLIGHT,
// so exactly one definition exists in any build configuration.

#if !defined(ENRICHED_MARKDOWN_CODE_HIGHLIGHT)

namespace Markdown {

std::vector<HighlightToken> highlightCode(const std::string & /*code*/, const std::string & /*language*/) {
  return {};
}

} // namespace Markdown

#else

#include "CodeBlockLanguages.hpp"
#include "HighlightGrammars.hpp"

#include <tree_sitter/api.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace Markdown {

namespace {

// Bounds the synchronous main-thread parse against pathological inputs. Typical
// blocks parse in sub-millisecond to low-millisecond time; anything past these
// caps falls back to plain rendering instead of risking a frame hang.
constexpr size_t kMaxBytes = 50u * 1024u;
constexpr size_t kMaxLines = 2000u;

// tree-sitter highlight capture names, flattened to their leading dotted
// prefix. The longest matching prefix wins, so "variable.member" resolves to
// Property while a bare "variable" resolves to Variable. Names with no entry
// (for example "spell", "none") are skipped and leave their bytes uncolored.
struct CaptureMapping {
  const char *prefix;
  HighlightTokenType type;
};

constexpr CaptureMapping kCaptureMappings[] = {
    {"keyword", HighlightTokenType::Keyword},
    {"operator", HighlightTokenType::Operator},
    {"punctuation", HighlightTokenType::Punctuation},
    {"string", HighlightTokenType::String},
    {"escape", HighlightTokenType::String},
    {"character", HighlightTokenType::String},
    {"number", HighlightTokenType::Number},
    {"float", HighlightTokenType::Number},
    {"boolean", HighlightTokenType::Constant},
    {"constant", HighlightTokenType::Constant},
    {"comment", HighlightTokenType::Comment},
    {"function", HighlightTokenType::Function},
    {"method", HighlightTokenType::Function},
    {"constructor", HighlightTokenType::Type},
    {"type", HighlightTokenType::Type},
    {"module", HighlightTokenType::Type},
    {"namespace", HighlightTokenType::Type},
    {"variable", HighlightTokenType::Variable},
    {"parameter", HighlightTokenType::Variable},
    {"variable.member", HighlightTokenType::Property},
    {"property", HighlightTokenType::Property},
    {"field", HighlightTokenType::Property},
    {"tag", HighlightTokenType::Tag},
    {"attribute", HighlightTokenType::Attribute},
    {"embedded", HighlightTokenType::Embedded},
    {"injection", HighlightTokenType::Embedded},
};

// A capture name matches a prefix only on dotted boundaries so "type" never
// swallows "typename"-style names. Returns false when nothing maps.
bool mapCaptureName(const char *name, uint32_t length, HighlightTokenType &out) {
  size_t best = 0;
  bool found = false;
  for (const CaptureMapping &m : kCaptureMappings) {
    size_t plen = std::strlen(m.prefix);
    if (plen > length || plen < best) {
      continue;
    }
    if (std::strncmp(name, m.prefix, plen) != 0) {
      continue;
    }
    if (plen != length && name[plen] != '.') {
      continue;
    }
    best = plen;
    out = m.type;
    found = true;
  }
  return found;
}

// Compiled queries are immutable after creation and reused across calls. Access
// is serialized on the main thread today; the mutex is cheap insurance should
// highlighting ever move off-main. A cached nullptr marks a query that failed to
// compile so it is not retried.
TSQuery *queryForLanguage(const TSLanguage *language, const char *source) {
  static std::mutex mutex;
  static std::unordered_map<const TSLanguage *, TSQuery *> cache;

  std::lock_guard<std::mutex> lock(mutex);
  auto it = cache.find(language);
  if (it != cache.end()) {
    return it->second;
  }

  uint32_t errorOffset = 0;
  TSQueryError errorType = TSQueryErrorNone;
  TSQuery *query = ts_query_new(language, source, static_cast<uint32_t>(std::strlen(source)), &errorOffset, &errorType);
  cache.emplace(language, query);
  return query;
}

// Precomputes, for every byte offset that starts a code point, the number of
// UTF-16 code units preceding it. Token boundaries always land on code-point
// boundaries, so mapping a byte offset is a single lookup. Astral code points
// (4-byte UTF-8) contribute a surrogate pair (+2).
std::vector<uint32_t> buildUtf16PrefixMap(const std::string &code) {
  const size_t n = code.size();
  std::vector<uint32_t> prefix(n + 1, 0);
  uint32_t units = 0;
  size_t i = 0;
  while (i < n) {
    unsigned char c = static_cast<unsigned char>(code[i]);
    size_t len;
    uint32_t width;
    if (c < 0x80) {
      len = 1;
      width = 1;
    } else if ((c >> 5) == 0x6) {
      len = 2;
      width = 1;
    } else if ((c >> 4) == 0xE) {
      len = 3;
      width = 1;
    } else if ((c >> 3) == 0x1E) {
      len = 4;
      width = 2;
    } else {
      len = 1;
      width = 1;
    }
    units += width;
    for (size_t k = 1; k <= len && i + k <= n; ++k) {
      prefix[i + k] = units;
    }
    i += len;
  }
  return prefix;
}

using ParserPtr = std::unique_ptr<TSParser, decltype(&ts_parser_delete)>;
using TreePtr = std::unique_ptr<TSTree, decltype(&ts_tree_delete)>;
using CursorPtr = std::unique_ptr<TSQueryCursor, decltype(&ts_query_cursor_delete)>;

} // namespace

// Resolves the language to a compiled grammar, parses the code, runs the
// grammar's highlight query, resolves overlapping captures (innermost span
// wins per byte), and returns coalesced foreground-only tokens with UTF-16
// offsets. Any failure along the way degrades to an empty vector (plain
// rendering).
std::vector<HighlightToken> highlightCode(const std::string &code, const std::string &language) {
  try {
    if (code.empty()) {
      return {};
    }

    std::string grammarId = canonicalGrammarId(language);
    if (grammarId.empty()) {
      return {};
    }
    const GrammarEntry *grammar = findGrammar(grammarId.c_str());
    if (grammar == nullptr) {
      return {};
    }

    if (code.size() > kMaxBytes) {
      return {};
    }
    size_t lines = 1;
    for (char c : code) {
      if (c == '\n' && ++lines > kMaxLines) {
        return {};
      }
    }

    ParserPtr parser(ts_parser_new(), ts_parser_delete);
    if (!parser) {
      return {};
    }
    const TSLanguage *tsLanguage = grammar->language();
    if (tsLanguage == nullptr || !ts_parser_set_language(parser.get(), tsLanguage)) {
      return {};
    }

    TSQuery *query = queryForLanguage(tsLanguage, grammar->highlightsQuery);
    if (query == nullptr) {
      return {};
    }

    TreePtr tree(ts_parser_parse_string(parser.get(), nullptr, code.c_str(), static_cast<uint32_t>(code.size())),
                 ts_tree_delete);
    if (!tree) {
      return {};
    }

    CursorPtr cursor(ts_query_cursor_new(), ts_query_cursor_delete);
    if (!cursor) {
      return {};
    }
    ts_query_cursor_exec(cursor.get(), query, ts_tree_root_node(tree.get()));

    // Innermost-wins overlap resolution: paint each capture's byte range,
    // widest span first, so tighter captures overwrite. A -1 byte is uncolored.
    struct Capture {
      uint32_t start;
      uint32_t end;
      HighlightTokenType type;
    };
    std::vector<Capture> captures;
    TSQueryMatch match;
    uint32_t captureIndex = 0;
    while (ts_query_cursor_next_capture(cursor.get(), &match, &captureIndex)) {
      const TSQueryCapture &capture = match.captures[captureIndex];
      uint32_t nameLength = 0;
      const char *name = ts_query_capture_name_for_id(query, capture.index, &nameLength);
      HighlightTokenType type;
      if (name == nullptr || !mapCaptureName(name, nameLength, type)) {
        continue;
      }
      uint32_t start = ts_node_start_byte(capture.node);
      uint32_t end = ts_node_end_byte(capture.node);
      if (end > start && end <= code.size()) {
        captures.push_back({start, end, type});
      }
    }
    if (captures.empty()) {
      return {};
    }

    std::stable_sort(captures.begin(), captures.end(),
                     [](const Capture &a, const Capture &b) { return (a.end - a.start) > (b.end - b.start); });

    std::vector<int8_t> byteType(code.size(), -1);
    for (const Capture &capture : captures) {
      for (uint32_t b = capture.start; b < capture.end; ++b) {
        byteType[b] = static_cast<int8_t>(capture.type);
      }
    }

    std::vector<uint32_t> u16 = buildUtf16PrefixMap(code);
    std::vector<HighlightToken> tokens;
    size_t b = 0;
    const size_t n = code.size();
    while (b < n) {
      if (byteType[b] < 0) {
        ++b;
        continue;
      }
      int8_t type = byteType[b];
      size_t runStart = b;
      while (b < n && byteType[b] == type) {
        ++b;
      }
      tokens.push_back({u16[runStart], u16[b], static_cast<HighlightTokenType>(type)});
    }
    return tokens;
  } catch (...) {
    return {};
  }
}

} // namespace Markdown

#endif
