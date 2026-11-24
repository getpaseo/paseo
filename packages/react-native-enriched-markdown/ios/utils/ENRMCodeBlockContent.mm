#import "ENRMCodeBlockContent.h"
#include "CodeBlockLanguages.hpp"
#import "ENRMUIKit.h"
#import "MarkdownASTNode.h"
#import "ParagraphStyleUtils.h"
#import "StyleConfig.h"

static void ENRMAppendNodeContent(MarkdownASTNode *node, NSMutableString *output)
{
  if (node.content.length > 0) {
    [output appendString:node.content];
  }
  for (MarkdownASTNode *child in node.children) {
    ENRMAppendNodeContent(child, output);
  }
}

NSString *ENRMCodeBlockExtractCode(MarkdownASTNode *node)
{
  NSMutableString *code = [NSMutableString string];
  ENRMAppendNodeContent(node, code);
  NSUInteger end = code.length;
  while (end > 0 && [code characterAtIndex:end - 1] == '\n') {
    end--;
  }
  return [code substringToIndex:end];
}

NSString *ENRMCodeBlockLanguage(MarkdownASTNode *node)
{
  NSString *language = node.attributes[@"language"];
  return language.length > 0 ? language : nil;
}

NSString *ENRMCodeBlockFenceChar(MarkdownASTNode *node)
{
  NSString *fenceChar = node.attributes[@"fenceChar"];
  return fenceChar.length > 0 ? fenceChar : @"`";
}

NSString *ENRMCodeBlockFencedMarkdown(NSString *code, NSString *language, NSString *fenceChar)
{
  NSString *fence = [@"" stringByPaddingToLength:3 withString:fenceChar startingAtIndex:0];
  return [NSString stringWithFormat:@"%@%@\n%@\n%@", fence, language ?: @"", code, fence];
}

NSString *ENRMCodeBlockDisplayLanguageName(NSString *language)
{
  if (language.length == 0) {
    return @"";
  }
  std::string display = Markdown::displayNameForLanguage(language.UTF8String ?: "");
  return [NSString stringWithUTF8String:display.c_str()] ?: language;
}

void ENRMApplyCodeBlockTextAttributes(NSMutableAttributedString *string, NSRange range, StyleConfig *config)
{
  if (range.length == 0) {
    return;
  }

  UIFont *font = [config codeBlockFont];
  RCTUIColor *color = [config codeBlockColor];
  if (color) {
    [string addAttributes:@{NSFontAttributeName : font, NSForegroundColorAttributeName : color} range:range];
  } else {
    [string addAttribute:NSFontAttributeName value:font range:range];
  }

  CGFloat lineHeight = [config codeBlockLineHeight];
  if (lineHeight > 0) {
    applyLineHeight(string, range, lineHeight);
  }

  NSMutableParagraphStyle *paragraphStyle = [getOrCreateParagraphStyle(string, range.location) mutableCopy];
  paragraphStyle.baseWritingDirection = NSWritingDirectionLeftToRight;
  paragraphStyle.alignment = NSTextAlignmentLeft;
  // Re-clamp: unlike paragraphs, code blocks reserve their height analytically as
  // lineCount * lineHeight (ENRMCodeBlockCodeHeight), so a line must not grow past the
  // configured lineHeight or a tall run (emoji, wide glyph) would overflow and clip the block.
  if (lineHeight > 0) {
    paragraphStyle.maximumLineHeight = lineHeight;
  }
  [string addAttribute:NSParagraphStyleAttributeName value:paragraphStyle range:range];

  if (lineHeight > 0) {
    applyBaselineOffset(string, range);
  }

  ENRMPinLineMetricsToStyledFonts(string, range);
}
