#include "ASTSerializer.hpp"
#include <cassert>
#include <cstdio>

namespace Markdown {

static const char *nodeTypeToString(NodeType type) {
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
    default:
      assert(false && "unhandled NodeType in nodeTypeToString");
      return "";
  }
}

void ASTSerializer::appendEscaped(const std::string &str, std::string &out) {
  out += '"';
  for (unsigned char c : str) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      default:
        if (c < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
        break;
    }
  }
  out += '"';
}

void ASTSerializer::serializeNode(const MarkdownASTNode &node, std::string &out) {
  out += "{\"type\":\"";
  out += nodeTypeToString(node.type);
  out += '"';

  if (!node.content.empty()) {
    out += ",\"content\":";
    appendEscaped(node.content, out);
  }

  if (!node.attributes.empty()) {
    out += ",\"attributes\":{";
    bool first = true;
    for (const auto &kv : node.attributes) {
      if (!first)
        out += ',';
      first = false;
      appendEscaped(kv.first, out);
      out += ':';
      appendEscaped(kv.second, out);
    }
    out += '}';
  }

  if (!node.children.empty()) {
    out += ",\"children\":[";
    for (size_t i = 0; i < node.children.size(); ++i) {
      if (i > 0)
        out += ',';
      serializeNode(*node.children[i], out);
    }
    out += ']';
  }

  out += '}';
}

std::string ASTSerializer::serialize(const MarkdownASTNode &node) {
  std::string out;
  out.reserve(1024);
  serializeNode(node, out);
  return out;
}

} // namespace Markdown
