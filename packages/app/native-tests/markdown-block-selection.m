#import <Foundation/Foundation.h>
#import "ENRMBlockSelectionRange.h"

static NSUInteger cases = 0;

static void expectRange(NSAttributedString *text, NSUInteger index, NSRange expected)
{
  cases++;
  NSRange actual = ENRMBlockSelectionRange(text, index);
  if (!NSEqualRanges(actual, expected)) {
    NSLog(@"Selection at %lu in %@: expected %@, got %@", (unsigned long)index, text.string,
          NSStringFromRange(expected), NSStringFromRange(actual));
    exit(1);
  }
}

int main(void)
{
  @autoreleasepool {
    expectRange([[NSAttributedString alloc] initWithString:@""], 0, NSMakeRange(NSNotFound, 0));
    expectRange([[NSAttributedString alloc] initWithString:@"text"], NSNotFound, NSMakeRange(NSNotFound, 0));
    expectRange([[NSAttributedString alloc] initWithString:@"text"], 4, NSMakeRange(NSNotFound, 0));
    expectRange([[NSAttributedString alloc] initWithString:@"first\nsecond\nthird"], 8, NSMakeRange(6, 6));
    expectRange([[NSAttributedString alloc] initWithString:@"\n\n"], 1, NSMakeRange(NSNotFound, 0));
    expectRange([[NSAttributedString alloc] initWithString:@"  body  \r\nnext"], 3, NSMakeRange(0, 8));

    NSMutableAttributedString *text = [[NSMutableAttributedString alloc] initWithString:@"first\nsecond\nthird"];
    // Adjacent list items must have distinct identities even if their styles match.
    [text addAttribute:ENRMSelectionBlockAttribute value:@1 range:NSMakeRange(0, 6)];
    [text addAttribute:ENRMSelectionBlockAttribute value:@2 range:NSMakeRange(6, 7)];
    [text addAttribute:ENRMSelectionBlockAttribute value:@3 range:NSMakeRange(13, 5)];
    [text addAttribute:@"InlineStyle" value:@"bold" range:NSMakeRange(7, 2)];
    expectRange(text, 8, NSMakeRange(6, 6));

    // Authored hard breaks remain within their logical paragraph/list item.
    [text addAttribute:ENRMSelectionBlockAttribute value:@1 range:NSMakeRange(0, 13)];
    expectRange(text, 8, NSMakeRange(0, 12));

    // A nested item owns its own range, without swallowing its parent or sibling.
    [text addAttribute:ENRMSelectionBlockAttribute value:@2 range:NSMakeRange(6, 7)];
    expectRange(text, 1, NSMakeRange(0, 5));
    expectRange(text, 8, NSMakeRange(6, 6));
    expectRange(text, 15, NSMakeRange(13, 5));

    NSString *unicode = @"前文\n👨‍👩‍👧‍👦 é 中文\n后文";
    NSRange body = [unicode rangeOfString:@"👨‍👩‍👧‍👦 é 中文"];
    expectRange([[NSAttributedString alloc] initWithString:unicode], body.location + 3, body);
    printf("Markdown block selection range: %lu cases passed\n", (unsigned long)cases);
  }
  return 0;
}
