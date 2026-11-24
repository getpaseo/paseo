#pragma once

#include <string>
#include <memory>
#include <vector>
#include <unordered_map>

namespace Markdown {

enum class NodeType {
    Document,
    Paragraph,
    Text,
    Link,
    Heading,
    LineBreak,
    Strong,
    Emphasis,
    Strikethrough,
    Underline,
    Code,
    Image,
    Blockquote,
    UnorderedList,
    OrderedList,
    ListItem,
    CodeBlock,
    ThematicBreak,
    Table,
    TableHead,
    TableBody,
    TableRow,
    TableHeaderCell,
    TableCell,
    LatexMathInline,
    LatexMathDisplay,
    Spoiler,
    Superscript,
    Subscript,
    Highlight,
    SoftBreak,
    BlankLine,
    Admonition,
    Video
};

struct MarkdownASTNode {
    NodeType type;
    std::string content;
    std::unordered_map<std::string, std::string> attributes;
    std::vector<std::shared_ptr<MarkdownASTNode>> children;

    explicit MarkdownASTNode(NodeType t) : type(t) {}

    void addChild(std::shared_ptr<MarkdownASTNode> child) {
        if (child) {
            children.push_back(std::move(child));
        }
    }

    void setAttribute(const std::string& key, const std::string& value) {
        attributes[key] = value;
    }
};

} // namespace Markdown

