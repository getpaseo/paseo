#pragma once

#import "ENRMBlockHandler.h"

NS_ASSUME_NONNULL_BEGIN

/// Block handler for unordered (bullet) list items. Reserves the head-indent
/// column for the marker via the paragraph style (the layout manager draws the
/// glyph into it) and serializes to a `- ` line prefix indented three spaces per
/// nesting level. Nesting depth is carried in ENRMBlockRange.level. Continues on
/// Return (a new item at the same depth) unlike single-line heading blocks.
@interface ENRMUnorderedListBlockHandler : NSObject <ENRMBlockHandler>
@end

NS_ASSUME_NONNULL_END
