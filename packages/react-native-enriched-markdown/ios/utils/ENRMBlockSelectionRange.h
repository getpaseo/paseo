#pragma once
#import <Foundation/Foundation.h>

// Logical paragraphs and list items keep one identity across inline styles and hard breaks.
static NSString *const ENRMSelectionBlockAttribute = @"ENRMSelectionBlock";

static inline NSRange ENRMBlockSelectionRange(NSAttributedString *text, NSUInteger index)
{
  if (index >= text.length)
    return NSMakeRange(NSNotFound, 0);

  NSRange range;
  id block = [text attribute:ENRMSelectionBlockAttribute
                    atIndex:index
      longestEffectiveRange:&range
                    inRange:NSMakeRange(0, text.length)];
  if (!block)
    range = [text.string paragraphRangeForRange:NSMakeRange(index, 0)];

  // Layout spacer and separator newlines belong to neither neighbouring block.
  NSCharacterSet *newlines = NSCharacterSet.newlineCharacterSet;
  while (range.length && [newlines characterIsMember:[text.string characterAtIndex:range.location]]) {
    range.location++;
    range.length--;
  }
  while (range.length && [newlines characterIsMember:[text.string characterAtIndex:NSMaxRange(range) - 1]])
    range.length--;
  return range.length ? range : NSMakeRange(NSNotFound, 0);
}
