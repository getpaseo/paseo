#pragma once

#import "ENRMInputBlockType.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Which shortcut families are enabled, normalized on the JS side so native
/// never sees the public `boolean | MarkdownShortcutsConfig` union.
typedef struct {
  BOOL heading;
  BOOL unorderedList;
  BOOL orderedList;
} ENRMMarkdownShortcutsConfig;

static inline BOOL ENRMMarkdownShortcutsEnabled(ENRMMarkdownShortcutsConfig config)
{
  return config.heading || config.unorderedList || config.orderedList;
}

/// Recognizes the markdown block prefixes a user types at the start of a
/// paragraph — `#`…`######`, `-`/`*`/`+`, `1.`/`1)` — so the input can turn the
/// paragraph into the matching block and drop the prefix (Notion-style
/// markdown shortcuts). Pure text matching; the caller owns the mutation.
@interface ENRMMarkdownShortcutMatcher : NSObject

/// Matches `prefix` (the paragraph text before the space the user just typed,
/// with no leading whitespace) against the shortcut grammar. Returns YES and
/// fills `outType`/`outLevel` on a match whose family `config` enables. Ordered
/// items match any number — the block store renumbers ordinals, so `3.` on a
/// fresh line still starts at 1.
+ (BOOL)matchPrefix:(NSString *)prefix
             config:(ENRMMarkdownShortcutsConfig)config
            outType:(ENRMInputBlockType *)outType
           outLevel:(NSInteger *)outLevel;

@end

NS_ASSUME_NONNULL_END
