#include "TextLinkRecognizer.hpp"

#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

namespace Markdown {

namespace {

using NodePtr = std::shared_ptr<MarkdownASTNode>;
using NodeList = std::vector<NodePtr>;

bool isOpaque(NodeType type) {
    switch (type) {
        case NodeType::Link:
        case NodeType::CodeBlock:
        case NodeType::Image:
        case NodeType::Video:
        case NodeType::LatexMathInline:
        case NodeType::LatexMathDisplay:
            return true;
        default:
            return false;
    }
}

NodePtr makeLink(NodePtr child, const std::string& url) {
    auto link = std::make_shared<MarkdownASTNode>(NodeType::Link);
    link->setAttribute("url", url);
    link->setAttribute("recognizedLink", "true");
    link->addChild(std::move(child));
    return link;
}

NodePtr textSlice(const MarkdownASTNode& source, std::string content) {
    auto text = std::make_shared<MarkdownASTNode>(NodeType::Text);
    text->content = std::move(content);
    text->attributes = source.attributes;
    return text;
}

// Byte offset of each UTF-16 code unit boundary in a UTF-8 string, plus the end.
std::vector<size_t> utf16BoundariesToBytes(const std::string& text) {
    std::vector<size_t> bytes;
    bytes.reserve(text.size() + 1);
    size_t i = 0;
    while (i < text.size()) {
        unsigned char lead = static_cast<unsigned char>(text[i]);
        size_t length = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
        if (i + length > text.size()) length = text.size() - i;
        bytes.push_back(i);
        if (length == 4) bytes.push_back(i); // surrogate pair: two units, one start
        i += length;
    }
    bytes.push_back(text.size());
    return bytes;
}

struct Candidate {
    MarkdownASTNode* parent;
    size_t index;
};

void collect(MarkdownASTNode& node, bool wantText, bool wantCode, std::vector<Candidate>& texts,
             std::vector<Candidate>& codes) {
    for (size_t i = 0; i < node.children.size(); i++) {
        MarkdownASTNode& child = *node.children[i];
        if (isOpaque(child.type)) continue;
        if (child.type == NodeType::Text) {
            if (wantText && !child.content.empty()) texts.push_back({&node, i});
        } else if (child.type == NodeType::Code) {
            if (wantCode) codes.push_back({&node, i});
        } else {
            collect(child, wantText, wantCode, texts, codes);
        }
    }
}

std::string codeContent(const MarkdownASTNode& code) {
    std::string content;
    for (const auto& child : code.children) content += child->content;
    return content;
}

using Replacements = std::unordered_map<const MarkdownASTNode*, NodeList>;

void splitText(const NodePtr& textNode, const std::vector<TextRange>& ranges, Replacements& out) {
    const std::string& content = textNode->content;
    std::vector<size_t> bytes = utf16BoundariesToBytes(content);
    NodeList pieces;
    size_t offset = 0;
    for (const TextRange& range : ranges) {
        if (range.end <= range.start || range.end >= bytes.size()) continue;
        size_t start = bytes[range.start];
        size_t end = bytes[range.end];
        if (start < offset || end <= start) continue;
        if (start > offset) pieces.push_back(textSlice(*textNode, content.substr(offset, start - offset)));
        std::string matched = content.substr(start, end - start);
        pieces.push_back(makeLink(textSlice(*textNode, matched), matched));
        offset = end;
    }
    if (offset == 0) return;
    if (offset < content.size()) pieces.push_back(textSlice(*textNode, content.substr(offset)));
    out[textNode.get()] = std::move(pieces);
}

void applyReplacements(MarkdownASTNode& node, const Replacements& replacements) {
    bool changed = false;
    for (const auto& child : node.children) {
        if (replacements.count(child.get())) {
            changed = true;
            break;
        }
    }
    if (changed) {
        NodeList children;
        children.reserve(node.children.size());
        for (const auto& child : node.children) {
            auto it = replacements.find(child.get());
            if (it == replacements.end()) {
                children.push_back(child);
            } else {
                children.insert(children.end(), it->second.begin(), it->second.end());
            }
        }
        node.children = std::move(children);
    }
    for (const auto& child : node.children) {
        if (!isOpaque(child->type)) applyReplacements(*child, replacements);
    }
}

} // namespace

void recognizeTextLinks(MarkdownASTNode& root, const TextLinkMatchers& matchers) {
    const bool wantText = static_cast<bool>(matchers.text);
    const bool wantCode = static_cast<bool>(matchers.inlineCode);
    if (!wantText && !wantCode) return;

    std::vector<Candidate> texts;
    std::vector<Candidate> codes;
    collect(root, wantText, wantCode, texts, codes);
    if (texts.empty() && codes.empty()) return;

    Replacements replacements;

    if (!texts.empty()) {
        std::vector<std::string_view> runs;
        runs.reserve(texts.size());
        for (const Candidate& c : texts) runs.emplace_back(c.parent->children[c.index]->content);
        std::vector<std::vector<TextRange>> matches = matchers.text(runs);
        for (size_t i = 0; i < texts.size() && i < matches.size(); i++) {
            if (!matches[i].empty()) splitText(texts[i].parent->children[texts[i].index], matches[i], replacements);
        }
    }

    if (!codes.empty()) {
        std::vector<std::string> contents;
        contents.reserve(codes.size());
        for (const Candidate& c : codes) contents.push_back(codeContent(*c.parent->children[c.index]));
        std::vector<std::string_view> spans(contents.begin(), contents.end());
        std::vector<uint8_t> matched = matchers.inlineCode(spans);
        for (size_t i = 0; i < codes.size() && i < matched.size(); i++) {
            if (!matched[i] || contents[i].empty()) continue;
            const NodePtr& code = codes[i].parent->children[codes[i].index];
            replacements[code.get()] = NodeList{makeLink(code, contents[i])};
        }
    }

    if (!replacements.empty()) applyReplacements(root, replacements);
}

} // namespace Markdown
