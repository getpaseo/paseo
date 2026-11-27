#import "ENRMMarkdownShortcutMatcher.h"

/// Upper bound on the digits accepted before `.`/`)`. Anything longer is a
/// number the user is writing, not a list marker.
static const NSUInteger kENRMMaxOrderedMarkerDigits = 9;

@implementation ENRMMarkdownShortcutMatcher

+ (BOOL)matchPrefix:(NSString *)prefix
             config:(ENRMMarkdownShortcutsConfig)config
            outType:(ENRMInputBlockType *)outType
           outLevel:(NSInteger *)outLevel
{
  NSUInteger length = prefix.length;
  if (length == 0) {
    return NO;
  }

  unichar first = [prefix characterAtIndex:0];

  // `#`{1,6} → heading at that level.
  if (first == '#') {
    if (!config.heading || length > 6) {
      return NO;
    }
    for (NSUInteger i = 1; i < length; i++) {
      if ([prefix characterAtIndex:i] != '#') {
        return NO;
      }
    }
    *outType = ENRMBlockTypeForHeadingLevel((NSInteger)length);
    *outLevel = (NSInteger)length;
    return YES;
  }

  // `-`, `*`, `+` → bullet item at depth 0.
  if (length == 1 && (first == '-' || first == '*' || first == '+')) {
    if (!config.unorderedList) {
      return NO;
    }
    *outType = ENRMInputBlockTypeUnorderedListItem;
    *outLevel = 0;
    return YES;
  }

  // digits followed by `.` or `)` → numbered item at depth 0.
  unichar last = [prefix characterAtIndex:length - 1];
  if ((last == '.' || last == ')') && length >= 2 && length - 1 <= kENRMMaxOrderedMarkerDigits) {
    for (NSUInteger i = 0; i < length - 1; i++) {
      unichar c = [prefix characterAtIndex:i];
      if (c < '0' || c > '9') {
        return NO;
      }
    }
    if (!config.orderedList) {
      return NO;
    }
    *outType = ENRMInputBlockTypeOrderedListItem;
    *outLevel = 0;
    return YES;
  }

  return NO;
}

@end
