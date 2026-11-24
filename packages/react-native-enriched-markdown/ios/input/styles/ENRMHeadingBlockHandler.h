#pragma once

#import "ENRMBlockHandler.h"

NS_ASSUME_NONNULL_BEGIN

/// Block handler for ATX headings (H1-H6). A single instance serves all six
/// levels: it dispatches on ENRMBlockRange.level for both styling (font size via
/// the formatter style's per-level config) and serialization (`#`*level prefix).
/// The formatter registers the same instance under all six heading block-type
/// keys.
@interface ENRMHeadingBlockHandler : NSObject <ENRMBlockHandler>
@end

NS_ASSUME_NONNULL_END
