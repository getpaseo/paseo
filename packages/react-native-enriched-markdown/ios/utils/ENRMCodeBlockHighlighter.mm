#import "ENRMCodeBlockHighlighter.h"
#include "CodeBlockHighlighter.hpp"
#import "ENRMUIKit.h"
#import "StyleConfig.h"

BOOL ENRMApplyHighlightTokens(NSMutableAttributedString *output, NSRange range, NSString *code,
                              NSString *_Nullable language, StyleConfig *config)
{
  if (code.length == 0) {
    return NO;
  }

  std::vector<Markdown::HighlightToken> tokens;
  try {
    tokens = Markdown::highlightCode(code.UTF8String ?: "", language.UTF8String ?: "");
  } catch (...) {
    return NO;
  }
  if (tokens.empty()) {
    return NO;
  }

  NSUInteger cap = MIN(NSMaxRange(range), output.length);
  BOOL applied = NO;
  for (const auto &token : tokens) {
    RCTUIColor *color = [config codeBlockSyntaxColorForToken:(NSInteger)token.type];
    if (!color || token.end <= token.start) {
      continue;
    }
    NSUInteger start = range.location + token.start;
    NSUInteger end = range.location + token.end;
    if (end > cap) {
      continue;
    }
    [output addAttribute:NSForegroundColorAttributeName value:color range:NSMakeRange(start, end - start)];
    applied = YES;
  }
  return applied;
}

NSAttributedString *ENRMHighlightedAttributedCode(NSAttributedString *plainCode, NSString *code,
                                                  NSString *_Nullable language, StyleConfig *config)
{
  if (code.length == 0) {
    return nil;
  }

  NSMutableAttributedString *highlighted = [plainCode mutableCopy];
  BOOL applied = ENRMApplyHighlightTokens(highlighted, NSMakeRange(0, highlighted.length), code, language, config);
  return applied ? highlighted : nil;
}
