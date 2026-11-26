#pragma once
#import "ENRMLinkPillAttachment.h"
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

static NSString *const CodeBlockAttributeName = @"CodeBlock";
static NSString *const CodeBlockIndentAttributeName = @"CodeBlockIndent";

/**
 * Returns YES when the last semantic block in the storage is a code block, ignoring any
 * trailing newline spacers (e.g. codeBlockMarginBottom) that may follow it.
 *
 * Detection is based on the last non-newline character: if it sits inside a CodeBlock
 * attribute run, the answer is YES regardless of what newlines come after.
 *
 * Use this in render-time cleanup paths (e.g. removeTrailingSpacing) that need to know
 * "is the document ending with a code block?" before any trailing newlines have been trimmed.
 * The stricter `isLastElementCodeBlock` would answer NO in that pre-trim state because
 * the CodeBlock range hasn't yet been pushed to text.length.
 */
static inline BOOL isLastBlockACodeBlock(NSAttributedString *text)
{
  if (text.length == 0)
    return NO;

  NSRange lastContent = [text.string rangeOfCharacterFromSet:[[NSCharacterSet newlineCharacterSet] invertedSet]
                                                     options:NSBackwardsSearch];
  if (lastContent.location == NSNotFound)
    return NO;

  NSNumber *isCodeBlock = [text attribute:CodeBlockAttributeName atIndex:lastContent.location effectiveRange:nil];
  return isCodeBlock.boolValue;
}

/**
 * Stricter sibling of `isLastBlockACodeBlock`: requires both that the last non-newline
 * character is inside a CodeBlock run AND that the CodeBlock range extends literally to
 * text.length (i.e. no characters at all live after the code block).
 *
 * Used in the iOS measurement path (and the analogous drawing-compensation check) to
 * decide whether to add `codeBlockPadding` to make up for iOS not measuring/drawing
 * trailing newlines that carry custom minimum/maximum line heights.
 *
 * After `removeTrailingSpacing` runs, the bottom padding spacer is preserved together
 * with a single trailing newline outside the code block range, so this returns NO and
 * the compensation is skipped — the bottom padding spacer is no longer the trailing
 * paragraph terminator, so iOS lays its line fragment out as part of usedRect normally.
 * The check still exists as a safety net for unexpected storage shapes.
 */
static inline BOOL isLastElementCodeBlock(NSAttributedString *text)
{
  if (text.length == 0)
    return NO;

  NSRange lastContent = [text.string rangeOfCharacterFromSet:[[NSCharacterSet newlineCharacterSet] invertedSet]
                                                     options:NSBackwardsSearch];
  if (lastContent.location == NSNotFound)
    return NO;

  NSNumber *isCodeBlock = [text attribute:CodeBlockAttributeName atIndex:lastContent.location effectiveRange:nil];
  if (!isCodeBlock.boolValue)
    return NO;

  NSRange codeBlockRange;
  [text attribute:CodeBlockAttributeName atIndex:lastContent.location effectiveRange:&codeBlockRange];
  return NSMaxRange(codeBlockRange) == text.length;
}

/**
 * Checks if the last element in the attributed string is an image attachment.
 * Used to compensate for iOS text attachment baseline spacing issues.
 */
static inline BOOL isLastElementImage(NSAttributedString *text)
{
  if (text.length == 0)
    return NO;

  NSRange lastContent = [text.string rangeOfCharacterFromSet:[[NSCharacterSet newlineCharacterSet] invertedSet]
                                                     options:NSBackwardsSearch];
  if (lastContent.location == NSNotFound)
    return NO;

  unichar lastChar = [text.string characterAtIndex:lastContent.location];
  if (lastChar != 0xFFFC)
    return NO;

  id attachment = [text attribute:NSAttachmentAttributeName atIndex:lastContent.location effectiveRange:nil];
#if !TARGET_OS_OSX
  // A link pill sits on the text baseline like a word; it needs no image compensation.
  if ([attachment isKindOfClass:[ENRMLinkPillAttachment class]])
    return NO;
#endif
  return attachment != nil;
}

NS_ASSUME_NONNULL_END
