#import "ParagraphStyleUtils.h"
#import "ENRMFeatureFlags.h"
#import "ENRMImageAttachment.h"
#import "ENRMLinkPillAttachment.h"
#import "LastElementUtils.h"
#import <React/RCTI18nUtil.h>

#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathInlineAttachment.h"
#endif

NSAttributedString *kNewlineAttributedString;
static NSParagraphStyle *kBlockSpacerTemplate;

NSLineBreakStrategy ENRMResolveLineBreakStrategy(NSString *strategy)
{
  if ([strategy isEqualToString:@"standard"]) {
    return NSLineBreakStrategyStandard;
  } else if ([strategy isEqualToString:@"hangul-word"]) {
    return NSLineBreakStrategyHangulWordPriority;
  } else if ([strategy isEqualToString:@"push-out"]) {
    return NSLineBreakStrategyPushOut;
  }
  return NSLineBreakStrategyNone;
}

NSLineBreakMode ENRMResolveEllipsizeLineBreakMode(NSString *mode)
{
  if ([mode isEqualToString:@"head"]) {
    return NSLineBreakByTruncatingHead;
  } else if ([mode isEqualToString:@"middle"]) {
    return NSLineBreakByTruncatingMiddle;
  } else if ([mode isEqualToString:@"clip"]) {
    return NSLineBreakByClipping;
  }
  return NSLineBreakByTruncatingTail;
}

__attribute__((constructor)) static void initParagraphStyleUtils(void)
{
  kNewlineAttributedString = [[NSAttributedString alloc] initWithString:@"\n"];

  NSMutableParagraphStyle *template = [[NSMutableParagraphStyle alloc] init];
  template.minimumLineHeight = 1;
  template.maximumLineHeight = 1;
  kBlockSpacerTemplate = [template copy];
}

ENRMWritingDirectionMode ENRMResolveWritingDirectionMode(NSString *value)
{
  if ([value isEqualToString:@"ltr"]) {
    return ENRMWritingDirectionModeLTR;
  }
  if ([value isEqualToString:@"rtl"]) {
    return ENRMWritingDirectionModeRTL;
  }
  if ([value isEqualToString:@"auto"]) {
    return ENRMWritingDirectionModeAuto;
  }
  return ENRMWritingDirectionModeFirstStrong;
}

static BOOL ENRMIsStrongRTLChar(unichar c)
{
  return (c >= 0x0590 && c <= 0x08FF) || (c >= 0xFB1D && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF);
}

NSWritingDirection ENRMFirstStrongDirection(NSString *text)
{
  NSCharacterSet *letters = [NSCharacterSet letterCharacterSet];
  NSUInteger length = text.length;
  for (NSUInteger i = 0; i < length; i++) {
    unichar c = [text characterAtIndex:i];
    if (![letters characterIsMember:c]) {
      continue;
    }
    return ENRMIsStrongRTLChar(c) ? NSWritingDirectionRightToLeft : NSWritingDirectionLeftToRight;
  }
  return NSWritingDirectionNatural;
}

BOOL ENRMParagraphIsRTL(NSParagraphStyle *style)
{
  if (style && style.baseWritingDirection != NSWritingDirectionNatural) {
    return style.baseWritingDirection == NSWritingDirectionRightToLeft;
  }
  return [[RCTI18nUtil sharedInstance] isRTL];
}

void ENRMApplyWritingDirectionMode(NSMutableAttributedString *output, ENRMWritingDirectionMode mode,
                                   NSWritingDirection layoutDirection)
{
  switch (mode) {
    case ENRMWritingDirectionModeAuto:
      ENRMApplyWritingDirectionToParagraphStyles(output, NSWritingDirectionNatural);
      break;
    case ENRMWritingDirectionModeLTR:
      ENRMApplyWritingDirectionToParagraphStyles(output, NSWritingDirectionLeftToRight);
      break;
    case ENRMWritingDirectionModeRTL:
      ENRMApplyWritingDirectionToParagraphStyles(output, NSWritingDirectionRightToLeft);
      break;
    case ENRMWritingDirectionModeFirstStrong:
      ENRMApplyFirstStrongParagraphDirections(output, layoutDirection);
      break;
  }
}

void ENRMApplyFirstStrongParagraphDirections(NSMutableAttributedString *output, NSWritingDirection fallback)
{
  if (output.length == 0) {
    return;
  }
  NSString *string = output.string;
  NSUInteger length = string.length;
  NSUInteger position = 0;
  while (position < length) {
    NSRange paragraphRange = [string paragraphRangeForRange:NSMakeRange(position, 0)];
    if (NSMaxRange(paragraphRange) <= position) {
      break;
    }
    position = NSMaxRange(paragraphRange);

    NSNumber *isCodeBlock = [output attribute:CodeBlockAttributeName
                                      atIndex:paragraphRange.location
                               effectiveRange:nil];
    if (isCodeBlock.boolValue) {
      continue;
    }

    NSWritingDirection direction = ENRMFirstStrongDirection([string substringWithRange:paragraphRange]);
    if (direction == NSWritingDirectionNatural) {
      direction = fallback;
    }
    if (direction == NSWritingDirectionNatural) {
      continue;
    }

    [output enumerateAttribute:NSParagraphStyleAttributeName
                       inRange:paragraphRange
                       options:0
                    usingBlock:^(NSParagraphStyle *style, NSRange range, BOOL *stop) {
                      if (style != nil && style.baseWritingDirection == direction) {
                        return;
                      }
                      NSMutableParagraphStyle *updated =
                          style ? [style mutableCopy] : [[NSMutableParagraphStyle alloc] init];
                      updated.baseWritingDirection = direction;
                      [output addAttribute:NSParagraphStyleAttributeName value:updated range:range];
                    }];
  }
}

void ENRMApplyWritingDirectionToParagraphStyles(NSMutableAttributedString *output, NSWritingDirection writingDirection)
{
  if (output.length == 0) {
    return;
  }
  [output enumerateAttribute:NSParagraphStyleAttributeName
                     inRange:NSMakeRange(0, output.length)
                     options:0
                  usingBlock:^(NSParagraphStyle *style, NSRange range, BOOL *stop) {
                    if (!style) {
                      return;
                    }
                    // Skip runs already in the target direction (issue #739),
                    // mirroring ENRMApplyFirstStrongParagraphDirections.
                    if (style.baseWritingDirection == writingDirection) {
                      return;
                    }
                    NSNumber *isCodeBlock = [output attribute:CodeBlockAttributeName
                                                      atIndex:range.location
                                               effectiveRange:nil];
                    if (isCodeBlock.boolValue) {
                      return;
                    }
                    NSMutableParagraphStyle *mutable = [style mutableCopy];
                    mutable.baseWritingDirection = writingDirection;
                    [output addAttribute:NSParagraphStyleAttributeName value:mutable range:range];
                  }];
}

NSMutableParagraphStyle *getOrCreateParagraphStyle(NSMutableAttributedString *output, NSUInteger index)
{
  NSParagraphStyle *existing = [output attribute:NSParagraphStyleAttributeName atIndex:index effectiveRange:NULL];
  NSMutableParagraphStyle *style = existing ? [existing mutableCopy] : [[NSMutableParagraphStyle alloc] init];
  return style;
}

void applyParagraphSpacingAfter(NSMutableAttributedString *output, NSUInteger start, CGFloat marginBottom)
{
  [output appendAttributedString:kNewlineAttributedString];

  NSMutableParagraphStyle *style = getOrCreateParagraphStyle(output, start);
  style.paragraphSpacing = marginBottom;

  NSRange range = NSMakeRange(start, output.length - start);
  [output addAttribute:NSParagraphStyleAttributeName value:style range:range];
}

NSUInteger applyParagraphSpacingBefore(NSMutableAttributedString *output, NSRange range, CGFloat marginTop)
{
  if (marginTop <= 0 || range.location == 0)
    return 0;

  NSUInteger prevIdx = range.location - 1;
  if ([output.string characterAtIndex:prevIdx] != '\n')
    return 0;

  NSParagraphStyle *prevStyle = [output attribute:NSParagraphStyleAttributeName atIndex:prevIdx effectiveRange:NULL];

  CGFloat prevMarginBottom = prevStyle.paragraphSpacing;
  if (prevMarginBottom >= marginTop)
    return 0;

  CGFloat extraGap = marginTop - prevMarginBottom;

  NSMutableParagraphStyle *spacerStyle = [kBlockSpacerTemplate mutableCopy];
  spacerStyle.paragraphSpacing = MAX(0, extraGap - 1.0);

  NSDictionary *attrs = @{NSParagraphStyleAttributeName : spacerStyle};
  NSAttributedString *spacer = [[NSAttributedString alloc] initWithString:@"\n" attributes:attrs];

  [output insertAttributedString:spacer atIndex:range.location];
  return 1;
}

NSUInteger applyBlockSpacingBefore(NSMutableAttributedString *output, NSUInteger insertionPoint, CGFloat marginTop)
{
  if (marginTop <= 0) {
    return 0;
  }

  CGFloat spacing = marginTop;

  // At index 0 the spacer \n produces a 1pt line fragment (minimumLineHeight=1)
  // on top of paragraphSpacing. Subtract it so the total equals the desired margin.
  // For non-zero positions the 1pt is intentional inter-block spacing.
  if (insertionPoint == 0) {
    spacing = MAX(0, marginTop - 1.0);
  }

  NSMutableParagraphStyle *spacerStyle = [kBlockSpacerTemplate mutableCopy];
  spacerStyle.paragraphSpacing = spacing;

  NSAttributedString *spacer =
      [[NSAttributedString alloc] initWithString:@"\n" attributes:@{NSParagraphStyleAttributeName : spacerStyle}];

  [output insertAttributedString:spacer atIndex:insertionPoint];
  return 1;
}

void applyBlockSpacingAfter(NSMutableAttributedString *output, CGFloat marginBottom)
{
  if (marginBottom <= 0) {
    return;
  }

  NSUInteger spacerLocation = output.length;
  [output appendAttributedString:kNewlineAttributedString];

  NSMutableParagraphStyle *spacerStyle = [kBlockSpacerTemplate mutableCopy];
  spacerStyle.paragraphSpacing = marginBottom;

  [output addAttribute:NSParagraphStyleAttributeName value:spacerStyle range:NSMakeRange(spacerLocation, 1)];
}

CGFloat ENRMLineHeightWithLinkPills(NSAttributedString *text, NSRange range, CGFloat lineHeight)
{
#if !TARGET_OS_OSX
  __block CGFloat fitting = lineHeight;
  [text enumerateAttribute:NSAttachmentAttributeName
                   inRange:range
                   options:0
                usingBlock:^(id value, __unused NSRange subrange, __unused BOOL *stop) {
                  if ([value isKindOfClass:ENRMLinkPillAttachment.class])
                    fitting = MAX(fitting, ((ENRMLinkPillAttachment *)value).lineHeight);
                }];
  return fitting;
#else
  return lineHeight;
#endif
}

// UIKit's own key for the pre-substitution font. Not exported by any SDK header, so it is spelled out
// here; it is the same string UIKit writes into a UITextView's storage when it substitutes a font.
static NSString *const ENRMOriginalFontAttributeName = @"NSOriginalFont";

void ENRMPinLineMetricsToStyledFonts(NSMutableAttributedString *output, NSRange range)
{
  if (range.length == 0 || NSMaxRange(range) > output.length) {
    return;
  }

  [output enumerateAttribute:NSFontAttributeName
                     inRange:range
                     options:0
                  usingBlock:^(UIFont *font, NSRange fontRange, __unused BOOL *stop) {
                    if (font) {
                      [output addAttribute:ENRMOriginalFontAttributeName value:font range:fontRange];
                    }
                  }];
}

// Floor, not clamp: minimumLineHeight keeps short lines at lineHeight, while maximumLineHeight = 0 lets
// a line grow to fit a taller run (large inline code, math, images) instead of clipping it, e.g.
// https://github.com/software-mansion/enriched-markdown/issues/827. We can diverge from RN's clamp
// because we measure the real laid-out height, so grown lines are reserved.
void ENRMApplyLineHeightToParagraphStyle(NSMutableParagraphStyle *style, CGFloat lineHeight)
{
  if (lineHeight <= 0) {
    return;
  }

  style.minimumLineHeight = lineHeight;
  style.maximumLineHeight = 0;
}

void applyLineHeight(NSMutableAttributedString *output, NSRange range, CGFloat lineHeight)
{
  lineHeight = ENRMLineHeightWithLinkPills(output, range, lineHeight);
  if (lineHeight <= 0) {
    return;
  }

  NSMutableParagraphStyle *style = getOrCreateParagraphStyle(output, range.location);
  ENRMApplyLineHeightToParagraphStyle(style, lineHeight);

  [output addAttribute:NSParagraphStyleAttributeName value:style range:range];
}

// Calculates the offset needed to center the text within the line height. Returns 0
// when the range has no minimum line height or its content already fills the line.
CGFloat calculateBaselineOffset(NSAttributedString *output, NSRange range)
{
  if (range.length == 0) {
    return 0;
  }

  // applyLineHeight floors lines with minimumLineHeight (maximumLineHeight is 0 for grown lines,
  // or equal to the minimum for re-clamped code blocks), so the target is the minimum line height.
  __block CGFloat targetLineHeight = 0;
  [output enumerateAttribute:NSParagraphStyleAttributeName
                     inRange:range
                     options:NSAttributedStringEnumerationLongestEffectiveRangeNotRequired
                  usingBlock:^(NSParagraphStyle *paragraphStyle, __unused NSRange subrange, __unused BOOL *stop) {
                    if (!paragraphStyle) {
                      return;
                    }
                    targetLineHeight = MAX(paragraphStyle.minimumLineHeight, targetLineHeight);
                  }];

  if (targetLineHeight <= 0) {
    return 0;
  }

  // Center on real text; on a math-only line center the math box instead of its font.
  __block CGFloat textLineHeight = 0;
#if ENRICHED_MARKDOWN_MATH
  __block BOOL hasMath = NO;
#endif
  [output enumerateAttributesInRange:range
                             options:0
                          usingBlock:^(NSDictionary<NSAttributedStringKey, id> *attrs, __unused NSRange subrange,
                                       __unused BOOL *stop) {
#if ENRICHED_MARKDOWN_MATH
                            if ([attrs[NSAttachmentAttributeName] isKindOfClass:[ENRMMathInlineAttachment class]]) {
                              hasMath = YES;
                              return;
                            }
#endif
                            UIFont *font = attrs[NSFontAttributeName];
                            if (font) {
                              textLineHeight = MAX(UIFontLineHeight(font), textLineHeight);
                            }
                          }];

  CGFloat contentLineHeight = textLineHeight;
#if !TARGET_OS_OSX
  __block CGFloat pillBoxHeight = 0;
  [output enumerateAttribute:NSAttachmentAttributeName
                     inRange:range
                     options:0
                  usingBlock:^(id value, NSRange subrange, BOOL *stop) {
                    if ([value isKindOfClass:ENRMLinkPillAttachment.class])
                      pillBoxHeight = MAX(pillBoxHeight, ((ENRMLinkPillAttachment *)value).boxHeight);
                  }];
  contentLineHeight = MAX(contentLineHeight, pillBoxHeight);
#endif

#if ENRICHED_MARKDOWN_MATH
  // Math only grows the content height, so measure it (parsing LaTeX) only when text
  // alone wouldn't already fill the line.
  if (hasMath && targetLineHeight > textLineHeight) {
    __block CGFloat mathBoxHeight = 0;
    [output enumerateAttribute:NSAttachmentAttributeName
                       inRange:range
                       options:0
                    usingBlock:^(id value, __unused NSRange subrange, __unused BOOL *stop) {
                      if ([value isKindOfClass:[ENRMMathInlineAttachment class]]) {
                        mathBoxHeight = MAX(((ENRMMathInlineAttachment *)value).boxHeight, mathBoxHeight);
                      }
                    }];
    contentLineHeight = MAX(contentLineHeight, mathBoxHeight);
  }
#endif

  if (contentLineHeight <= 0 || targetLineHeight <= contentLineHeight) {
    return 0;
  }

  return (targetLineHeight - contentLineHeight) / 2.0;
}

// Centers text within its line height (see calculateBaselineOffset). Called per block over its
// own range so blocks can keep different line heights. Ranges that already carry a baseline offset
// are left untouched, keeping nesting (e.g. a blockquote wrapping list items) idempotent.
void applyBaselineOffset(NSMutableAttributedString *output, NSRange range)
{
  CGFloat baseLineOffset = calculateBaselineOffset(output, range);
  if (baseLineOffset <= 0) {
    return;
  }

  [output enumerateAttribute:NSBaselineOffsetAttributeName
                     inRange:range
                     options:0
                  usingBlock:^(NSNumber *existingOffset, NSRange subrange, BOOL *stop) {
                    if (existingOffset != nil) {
                      return;
                    }
                    [output enumerateAttribute:NSAttachmentAttributeName
                                       inRange:subrange
                                       options:0
                                    usingBlock:^(id attachment, NSRange attachmentRange, BOOL *innerStop) {
                                      if ([attachment isKindOfClass:[ENRMImageAttachment class]] &&
                                          !((ENRMImageAttachment *)attachment).isInline) {
                                        return;
                                      }
                                      [output addAttribute:NSBaselineOffsetAttributeName
                                                     value:@(baseLineOffset)
                                                     range:attachmentRange];
                                    }];
                  }];
}

void applyTextAlignment(NSMutableAttributedString *output, NSRange range, NSTextAlignment textAlign)
{
  NSMutableParagraphStyle *style = getOrCreateParagraphStyle(output, range.location);
  style.alignment = textAlign;
  [output addAttribute:NSParagraphStyleAttributeName value:style range:range];
}

void ENRMApplyLineBreakStrategyToParagraphStyles(NSMutableAttributedString *output,
                                                 NSLineBreakStrategy lineBreakStrategy)
{
  if (output.length == 0) {
    return;
  }
  [output enumerateAttribute:NSParagraphStyleAttributeName
                     inRange:NSMakeRange(0, output.length)
                     options:0
                  usingBlock:^(NSParagraphStyle *value, NSRange range, BOOL *stop) {
                    if (!value) {
                      return;
                    }
                    NSMutableParagraphStyle *mutable = [value mutableCopy];
                    mutable.lineBreakStrategy = lineBreakStrategy;
                    [output addAttribute:NSParagraphStyleAttributeName value:mutable range:range];
                  }];
}

NSTextAlignment textAlignmentFromString(NSString *textAlign)
{
  if ([textAlign isEqualToString:@"left"]) {
    return NSTextAlignmentLeft;
  } else if ([textAlign isEqualToString:@"center"]) {
    return NSTextAlignmentCenter;
  } else if ([textAlign isEqualToString:@"right"]) {
    return NSTextAlignmentRight;
  } else if ([textAlign isEqualToString:@"justify"]) {
    return NSTextAlignmentJustified;
  }
  return NSTextAlignmentNatural;
}
