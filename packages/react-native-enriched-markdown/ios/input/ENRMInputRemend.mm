#import "ENRMInputRemend.h"

typedef struct {
  NSString *__unsafe_unretained open;
  NSString *__unsafe_unretained close;
  BOOL symmetric;
  // Emphasis-family delimiters (*, _, ~~) only open when left-flanking; code spans
  // and spoilers open regardless of surrounding whitespace, so they skip the check.
  BOOL flanking;
} ENRMDelimiterPair;

static const ENRMDelimiterPair kDelimiterPairs[] = {
    {@"***", @"***", YES, YES}, {@"**", @"**", YES, YES}, {@"*", @"*", YES, YES}, {@"_", @"_", YES, YES},
    {@"~~", @"~~", YES, YES},   {@"||", @"||", YES, NO},  {@"`", @"`", YES, NO},  {@"[", @"]", NO, NO},
};
static const NSUInteger kDelimiterPairCount = sizeof(kDelimiterPairs) / sizeof(kDelimiterPairs[0]);

static NSString *closingForStackEntry(NSString *entry)
{
  for (NSUInteger i = 0; i < kDelimiterPairCount; i++) {
    if ([entry isEqualToString:kDelimiterPairs[i].open]) {
      return kDelimiterPairs[i].close;
    }
  }
  return entry;
}

// 0 = whitespace or out-of-bounds boundary, 1 = punctuation, 2 = letter/digit.
static int flankingLevelAt(NSString *markdown, NSInteger index)
{
  if (index < 0 || index >= (NSInteger)markdown.length) {
    return 0;
  }
  unichar c = [markdown characterAtIndex:(NSUInteger)index];
  if ([[NSCharacterSet whitespaceAndNewlineCharacterSet] characterIsMember:c]) {
    return 0;
  }
  if ([[NSCharacterSet alphanumericCharacterSet] characterIsMember:c]) {
    return 2;
  }
  return 1;
}

// Mirrors md4c's emphasis opener test so completion only closes a delimiter md4c
// would actually treat as an opener: the run is a potential opener when its right
// side is "stronger" than its left (rightLevel > 0 and rightLevel >= leftLevel),
// where each side is scored 0 = whitespace/boundary, 1 = punctuation, 2 = other.
// Intraword underscore (both sides "other") never opens. This rejects lone or
// whitespace/punctuation-flanked delimiters (control*, 2 * 3, a*., a_b) that would
// otherwise fabricate a marker. Intraword * (a*b) is a genuine md4c opener, so it is
// not (and cannot be) rejected here.
static BOOL isEmphasisOpener(NSString *markdown, NSUInteger start, NSString *open)
{
  int leftLevel = flankingLevelAt(markdown, (NSInteger)start - 1);
  int rightLevel = flankingLevelAt(markdown, (NSInteger)start + (NSInteger)open.length);
  if ([open isEqualToString:@"_"] && leftLevel == 2 && rightLevel == 2) {
    return NO;
  }
  return rightLevel > 0 && rightLevel >= leftLevel;
}

NSString *ENRMInputRemendComplete(NSString *markdown)
{
  if (markdown.length == 0) {
    return markdown;
  }

  NSMutableArray<NSString *> *stack = [[NSMutableArray alloc] init];
  BOOL inLinkParen = NO;
  NSUInteger length = markdown.length;
  NSUInteger i = 0;

  while (i < length) {
    unichar c = [markdown characterAtIndex:i];

    if (c == '\\' && i + 1 < length) {
      i += 2;
      continue;
    }

    // Link URL parentheses are a special two-character transition from "]("
    if (c == ']' && !inLinkParen && i + 1 < length && [markdown characterAtIndex:i + 1] == '(') {
      NSUInteger bracketIndex = NSNotFound;
      for (NSUInteger idx = stack.count; idx > 0; idx--) {
        if ([stack[idx - 1] isEqualToString:@"["]) {
          bracketIndex = idx - 1;
          break;
        }
      }
      if (bracketIndex != NSNotFound) {
        [stack removeObjectsInRange:NSMakeRange(bracketIndex, stack.count - bracketIndex)];
      }
      inLinkParen = YES;
      i += 2;
      continue;
    }

    if (inLinkParen && c == ')') {
      inLinkParen = NO;
      i++;
      continue;
    }

    if (inLinkParen) {
      i++;
      continue;
    }

    BOOL matched = NO;
    for (NSUInteger p = 0; p < kDelimiterPairCount; p++) {
      ENRMDelimiterPair pair = kDelimiterPairs[p];
      NSUInteger openLen = pair.open.length;

      if (i + openLen > length) {
        continue;
      }

      NSString *substring = [markdown substringWithRange:NSMakeRange(i, openLen)];

      if (pair.symmetric) {
        if ([substring isEqualToString:pair.open]) {
          if (stack.count > 0 && [stack.lastObject isEqualToString:pair.open]) {
            [stack removeLastObject];
          } else if (!pair.flanking || isEmphasisOpener(markdown, i, pair.open)) {
            [stack addObject:pair.open];
          }
          i += openLen;
          matched = YES;
          break;
        }
      } else {
        if ([substring isEqualToString:pair.open]) {
          [stack addObject:pair.open];
          i += openLen;
          matched = YES;
          break;
        }
        NSUInteger closeLen = pair.close.length;
        if (i + closeLen <= length) {
          NSString *closeSub = [markdown substringWithRange:NSMakeRange(i, closeLen)];
          if ([closeSub isEqualToString:pair.close]) {
            if (stack.count > 0 && [stack.lastObject isEqualToString:pair.open]) {
              [stack removeLastObject];
            }
            i += closeLen;
            matched = YES;
            break;
          }
        }
      }
    }

    if (!matched) {
      i++;
    }
  }

  NSMutableString *closingSuffix = [NSMutableString string];

  if (inLinkParen) {
    [closingSuffix appendString:@")"];
  }

  for (NSString *entry in [stack reverseObjectEnumerator]) {
    [closingSuffix appendString:closingForStackEntry(entry)];
  }

  if (closingSuffix.length == 0) {
    return markdown;
  }

  return [markdown stringByAppendingString:closingSuffix];
}
