#pragma once
#import <Foundation/Foundation.h>

@class MarkdownASTNode;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Serializes an AST node (and its children) back to markdown syntax.
/// Handles inline elements: strong, emphasis, strikethrough, underline, code, links, images.
NSString *markdownFromASTNode(MarkdownASTNode *node);

/// Serializes only the children of a node to markdown (skipping the node itself).
/// Useful for extracting the markdown content of a container node (e.g. a table cell).
NSString *markdownFromASTNodeChildren(MarkdownASTNode *node);

/// Serializes a Blockquote or Admonition node to full markdown, including `> ` line
/// prefixes and `> [!TYPE]` header for admonitions.
NSString *markdownFromBlockquoteNode(MarkdownASTNode *node);

/// Extracts plain text content from an AST node recursively (no markdown syntax).
NSString *plainTextFromASTNode(MarkdownASTNode *node);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
