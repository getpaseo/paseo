#pragma once

#include "MarkdownASTNode.hpp"
#include <cstddef>
#include <functional>
#include <cstdint>
#include <string_view>
#include <vector>

namespace Markdown {

// Offsets are UTF-16 code units, as every host regex engine reports them.
struct TextRange {
    size_t start;
    size_t end;
};

// Host-provided matching, one call per kind per parse. A null function is off.
struct TextLinkMatchers {
    // Non-overlapping matches per run, in order.
    std::function<std::vector<std::vector<TextRange>>(const std::vector<std::string_view>& runs)> text;
    std::function<std::vector<uint8_t>(const std::vector<std::string_view>& spans)> inlineCode;
};

// In place. Existing links, code blocks, media and math are not entered.
void recognizeTextLinks(MarkdownASTNode& root, const TextLinkMatchers& matchers);

} // namespace Markdown
