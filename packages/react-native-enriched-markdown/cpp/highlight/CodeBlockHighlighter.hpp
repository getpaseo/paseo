#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Shared seam for optional syntax highlighting of fenced code blocks.
//
// The real implementation is compiled only when ENRICHED_MARKDOWN_CODE_HIGHLIGHT
// is defined by the build. Without the flag the stub in CodeBlockHighlighter.cpp
// returns no tokens and platform callers keep the plain uncolored rendering, so
// the absent module degrades to the default code block appearance. The same
// fallback applies at runtime when a language has no compiled grammar or
// highlighting fails.
//
// The seam returns semantic tokens instead of a platform text type on
// purpose. Platform adapters map token types to foreground colors and apply
// them to their attributed string. Since foreground color never affects text
// metrics, the block height measured from the plain string is guaranteed to
// match the drawn height regardless of what an implementation returns.
//
// Token offsets are UTF-16 code units into the code string, because both
// Android (Spannable) and iOS (NSAttributedString) address text in UTF-16.
// Implementations are responsible for converting tree-sitter byte offsets.
//
// Token types follow tree-sitter's standard highlight capture names,
// flattened to one level. Values are explicit because they cross the JNI
// boundary as plain integers.
//
// Both markdown flavors call this seam: the github flavor highlights the code
// string in its container view, and the commonmark renderers
// (CodeBlockRenderer.kt / CodeBlockRenderer.m) apply the tokens to their
// content range through the platform adapters.

namespace Markdown {

enum class HighlightTokenType : uint8_t {
    Keyword = 0,
    Operator = 1,
    Punctuation = 2,
    String = 3,
    Number = 4,
    Constant = 5,
    Comment = 6,
    Function = 7,
    Type = 8,
    Variable = 9,
    Property = 10,
    Tag = 11,
    Attribute = 12,
    Embedded = 13,
};

struct HighlightToken {
    uint32_t start;
    uint32_t end;
    HighlightTokenType type;
};

// code is the UTF-8 code block content without the fence lines; language is
// the fence info string (for example "python"), empty when absent. Returns an
// empty vector whenever highlighting is unavailable (module compiled out,
// unknown language, parse failure).
std::vector<HighlightToken> highlightCode(const std::string& code, const std::string& language);

} // namespace Markdown
