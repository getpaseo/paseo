#import "MarkdownExtractor.h"
#import "BaselineShiftTextAttributes.h"
#import "BlockquoteBorder.h"
#import "CodeBackground.h"
#import "ENRMFeatureFlags.h"
#import "ENRMImageAttachment.h"
#import "ENRMLinkPillText.h"
#import "ENRMTextLinkAttributes.h"
#import "ENRMUIKit.h"
#import "HighlightRenderer.h"
#include <TargetConditionals.h>
#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathInlineAttachment.h"
#endif
#import "LastElementUtils.h"
#import "ListItemRenderer.h"
#import "RuntimeKeys.h"
#import "ThematicBreakAttachment.h"

#pragma mark - Extraction Context

typedef struct {
  NSInteger blockquoteDepth; // -1 = not in blockquote
  NSInteger listDepth;       // -1 = not in list
  BOOL needsBlankLine;
} ExtractionState;

#pragma mark - Helper Functions

static void ensureBlankLine(NSMutableString *result)
{
  if (result.length == 0)
    return;
  if ([result hasSuffix:@"\n\n"])
    return;

  [result appendString:[result hasSuffix:@"\n"] ? @"\n" : @"\n\n"];
}

static BOOL isAtLineStart(NSMutableString *result)
{
  return result.length == 0 || [result hasSuffix:@"\n"];
}

/// Depth 0 = "> ", Depth 1 = "> > ", etc.
static NSString *buildBlockquotePrefix(NSInteger depth)
{
  NSMutableString *prefix = [NSMutableString string];
  for (NSInteger i = 0; i <= depth; i++) {
    [prefix appendString:@"> "];
  }
  return prefix;
}

static NSString *buildListPrefix(NSInteger depth, BOOL isOrdered, NSInteger itemNumber)
{
  NSString *indent = [@"" stringByPaddingToLength:(depth * 2) withString:@" " startingAtIndex:0];
  NSString *marker = isOrdered ? [NSString stringWithFormat:@"%ld.", (long)itemNumber] : @"-";
  return [NSString stringWithFormat:@"%@%@ ", indent, marker];
}

static NSString *buildHeadingPrefix(NSInteger level)
{
  return [NSString stringWithFormat:@"%@ ", [@"" stringByPaddingToLength:level withString:@"#" startingAtIndex:0]];
}

static void extractFontTraits(NSDictionary *attrs, BOOL *isBold, BOOL *isItalic, BOOL *isMonospace)
{
  UIFont *font = attrs[NSFontAttributeName];
  *isBold = NO;
  *isItalic = NO;
  *isMonospace = NO;

  if (font) {
    UIFontDescriptorSymbolicTraits traits = font.fontDescriptor.symbolicTraits;
    *isBold = (traits & UIFontDescriptorTraitBold) != 0;
    *isItalic = (traits & UIFontDescriptorTraitItalic) != 0;
#if !TARGET_OS_OSX
    *isMonospace = (traits & UIFontDescriptorTraitMonoSpace) != 0;
#else
    *isMonospace = (traits & NSFontDescriptorTraitMonoSpace) != 0;
#endif
  }
}

static NSString *applyInlineFormatting(NSString *text, BOOL isBold, BOOL isItalic, BOOL isMonospace,
                                       BOOL isStrikethrough, BOOL isUnderline, BOOL isSuperscript, BOOL isSubscript,
                                       BOOL isHighlight, NSString *linkURL)
{
  NSMutableString *result = [NSMutableString stringWithString:text];

  // Innermost first
  if (isMonospace && !linkURL) {
    result = [NSMutableString stringWithFormat:@"`%@`", result];
  }
  if (isStrikethrough) {
    result = [NSMutableString stringWithFormat:@"~~%@~~", result];
  }
  if (isSubscript) {
    result = [NSMutableString stringWithFormat:@"~%@~", result];
  }
  if (isSuperscript) {
    result = [NSMutableString stringWithFormat:@"^%@^", result];
  }
  if (isUnderline && !linkURL) {
    result = [NSMutableString stringWithFormat:@"<u>%@</u>", result];
  }
  if (isItalic) {
    result = [NSMutableString stringWithFormat:@"*%@*", result];
  }
  if (isBold) {
    result = [NSMutableString stringWithFormat:@"**%@**", result];
  }
  if (linkURL) {
    result = [NSMutableString stringWithFormat:@"[%@](%@)", result, linkURL];
  }
  if (isHighlight) {
    result = [NSMutableString stringWithFormat:@"==%@==", result];
  }

  return result;
}

#pragma mark - Main Extraction Function

NSString *_Nullable extractMarkdownFromAttributedString(NSAttributedString *attributedText, NSRange range)
{
  if (!attributedText || range.length == 0 || range.location >= attributedText.length) {
    return nil;
  }

  range.length = MIN(range.length, attributedText.length - range.location);
  attributedText = ENRMAttributedStringByExpandingLinkPills(attributedText, &range);

  NSMutableString *result = [NSMutableString string];

  // Headings may span multiple attribute runs
  __block NSString *currentHeadingType = nil;
  __block NSMutableString *headingContent = nil;
  __block ExtractionState state = {.blockquoteDepth = -1, .listDepth = -1, .needsBlankLine = NO};

  void (^flushHeading)(void) = ^{
    if (!currentHeadingType || headingContent.length == 0)
      return;

    ensureBlankLine(result);
    NSInteger level = [[currentHeadingType substringFromIndex:8] integerValue];
    [result appendFormat:@"%@%@\n", buildHeadingPrefix(level), headingContent];

    currentHeadingType = nil;
    headingContent = nil;
    state.needsBlankLine = YES;
  };

  [attributedText
      enumerateAttributesInRange:range
                         options:0
                      usingBlock:^(NSDictionary<NSAttributedStringKey, id> *attrs, NSRange attrRange, BOOL *stop) {
                        NSString *text = [[attributedText attributedSubstringFromRange:attrRange] string];
                        if (text.length == 0)
                          return;

                        // Images and Thematic Breaks
                        NSTextAttachment *attachment = attrs[NSAttachmentAttributeName];
                        if ([attachment isKindOfClass:[ENRMImageAttachment class]]) {
                          ENRMImageAttachment *img = (ENRMImageAttachment *)attachment;
                          if (!img.imageURL)
                            return;

                          if (img.isInline) {
                            [result appendFormat:@"![image](%@)", img.imageURL];
                          } else {
                            ensureBlankLine(result);
                            [result appendFormat:@"![image](%@)\n", img.imageURL];
                            state.needsBlankLine = YES;
                            state.blockquoteDepth = -1;
                            state.listDepth = -1;
                          }
                          return;
                        }

                        if ([attachment isKindOfClass:[ThematicBreakAttachment class]]) {
                          ensureBlankLine(result);
                          [result appendString:@"---\n"];
                          state.needsBlankLine = YES;
                          state.blockquoteDepth = -1;
                          state.listDepth = -1;
                          return;
                        }

#if ENRICHED_MARKDOWN_MATH
                        if ([attachment isKindOfClass:[ENRMMathInlineAttachment class]]) {
                          ENRMMathInlineAttachment *math = (ENRMMathInlineAttachment *)attachment;
                          if (math.latex.length > 0) {
                            [result appendFormat:@"$%@$", math.latex];
                          }
                          return;
                        }
#endif

                        if ([text isEqualToString:@"\uFFFC"])
                          return;

                        // Newlines
                        if ([text isEqualToString:@"\n"] || [text isEqualToString:@"\n\n"]) {
                          NSNumber *bqDepth = attrs[BlockquoteDepthAttributeName];
                          NSNumber *listDepth = attrs[ListDepthAttribute];
                          BOOL inBlockquote = (bqDepth != nil);
                          BOOL inList = (listDepth != nil);

                          if (!inBlockquote && state.blockquoteDepth >= 0) {
                            ensureBlankLine(result);
                            state.blockquoteDepth = -1;
                            return;
                          }

                          if (!inList && state.listDepth >= 0) {
                            ensureBlankLine(result);
                            state.listDepth = -1;
                            return;
                          }

                          if (inBlockquote || inList) {
                            if (![result hasSuffix:@"\n"]) {
                              [result appendString:@"\n"];
                            }
                            return;
                          }

                          ensureBlankLine(result);
                          return;
                        }

                        // Headings
                        NSString *markdownType = attrs[MarkdownTypeAttributeName];

                        if (markdownType && [markdownType hasPrefix:@"heading-"]) {
                          if (![markdownType isEqualToString:currentHeadingType]) {
                            flushHeading();
                            currentHeadingType = markdownType;
                            headingContent = [NSMutableString string];
                          }
                          [headingContent
                              appendString:[text stringByTrimmingCharactersInSet:[NSCharacterSet newlineCharacterSet]]];
                          return;
                        } else if (currentHeadingType) {
                          flushHeading();
                        }

                        // Code blocks
                        NSNumber *isCodeBlock = attrs[CodeBlockAttributeName];
                        if ([isCodeBlock boolValue]) {
                          if (state.needsBlankLine) {
                            ensureBlankLine(result);
                            state.needsBlankLine = NO;
                          }

                          BOOL needsFence = (result.length == 0) || [result hasSuffix:@"\n\n"];
                          if (needsFence) {
                            [result appendString:@"```\n"];
                          }

                          [result appendString:text];

                          if ([text hasSuffix:@"\n"]) {
                            [result appendString:@"```\n"];
                            state.needsBlankLine = YES;
                          }
                          return;
                        }

                        // Blockquotes
                        NSNumber *bqDepthNum = attrs[BlockquoteDepthAttributeName];
                        NSInteger currentBqDepth = bqDepthNum ? [bqDepthNum integerValue] : -1;
                        NSString *blockquotePrefix = nil;

                        if (currentBqDepth >= 0) {
                          blockquotePrefix = buildBlockquotePrefix(currentBqDepth);
                          state.blockquoteDepth = currentBqDepth;
                        } else if (state.blockquoteDepth >= 0) {
                          ensureBlankLine(result);
                          state.blockquoteDepth = -1;
                        }

                        // Lists
                        NSNumber *listDepthNum = attrs[ListDepthAttribute];
                        NSNumber *listTypeNum = attrs[ListTypeAttribute];
                        NSNumber *listItemNum = attrs[ListItemNumberAttribute];
                        BOOL isTaskItem = [attrs[TaskItemAttribute] boolValue];
                        BOOL isTaskChecked = [attrs[TaskCheckedAttribute] boolValue];
                        NSInteger currentListDepth = listDepthNum ? [listDepthNum integerValue] : -1;

                        if (currentListDepth >= 0) {
                          state.listDepth = currentListDepth;
                        } else if (state.listDepth >= 0) {
                          ensureBlankLine(result);
                          state.listDepth = -1;
                        }

                        // Inline formatting
                        BOOL isBold, isItalic, isMonospace;
                        BOOL recognizedLink = [attrs[ENRMRecognizedLinkAttributeName] boolValue];
                        extractFontTraits(attrs, &isBold, &isItalic, &isMonospace);
                        if (recognizedLink)
                          isMonospace = [attrs[CodeAttributeName] boolValue];

                        NSNumber *strikethroughStyle = attrs[NSStrikethroughStyleAttributeName];
                        BOOL isStrikethrough = (strikethroughStyle != nil && [strikethroughStyle integerValue] != 0);
                        NSNumber *underlineStyle = recognizedLink
                                                       ? attrs[ENRMRecognizedLinkOriginalUnderlineAttributeName]
                                                       : attrs[NSUnderlineStyleAttributeName];
                        BOOL isUnderline = (underlineStyle != nil && [underlineStyle integerValue] != 0);
                        // Line-height alignment also shifts baselines. Only semantic script spans
                        // should produce superscript/subscript Markdown on the clipboard.
                        NSString *script = attrs[ENRMScriptAttributeName];
                        BOOL isSuperscript = [script isEqualToString:ENRMScriptValueSuperscript];
                        BOOL isSubscript = [script isEqualToString:ENRMScriptValueSubscript];

                        BOOL isHighlight = [attrs[HighlightAttributeName] boolValue];
                        NSString *linkURL = recognizedLink ? nil : attrs[NSLinkAttributeName];
                        NSString *segment =
                            applyInlineFormatting(text, isBold, isItalic, isMonospace, isStrikethrough, isUnderline,
                                                  isSuperscript, isSubscript, isHighlight, linkURL);

                        // Add block prefixes at line start
                        if (isAtLineStart(result)) {
                          NSMutableString *prefixedSegment = [NSMutableString string];

                          if (listDepthNum && ![text hasPrefix:@"\n"]) {
                            if (isTaskItem) {
                              NSString *indent = [@"" stringByPaddingToLength:(currentListDepth * 2)
                                                                   withString:@" "
                                                              startingAtIndex:0];
                              NSString *checkbox = isTaskChecked ? @"[x]" : @"[ ]";
                              [prefixedSegment appendFormat:@"%@- %@ ", indent, checkbox];
                            } else {
                              BOOL isOrdered = ([listTypeNum integerValue] == 1);
                              NSInteger itemNumber = listItemNum ? [listItemNum integerValue] : 1;
                              [prefixedSegment appendString:buildListPrefix(currentListDepth, isOrdered, itemNumber)];
                            }
                          }

                          if (blockquotePrefix) {
                            [prefixedSegment insertString:blockquotePrefix atIndex:0];
                          }

                          [prefixedSegment appendString:segment];
                          segment = prefixedSegment;
                        }

                        if (state.needsBlankLine && result.length > 0) {
                          ensureBlankLine(result);
                          state.needsBlankLine = NO;
                        }

                        [result appendString:segment];
                      }];

  // Flush remaining heading
  if (currentHeadingType && headingContent.length > 0) {
    ensureBlankLine(result);
    NSInteger level = [[currentHeadingType substringFromIndex:8] integerValue];
    [result appendFormat:@"%@%@\n", buildHeadingPrefix(level), headingContent];
  }

  return result.length > 0 ? result : nil;
}
