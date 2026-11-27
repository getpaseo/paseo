#pragma once

#import "ENRMBlockHandler.h"

NS_ASSUME_NONNULL_BEGIN

/// Block handler for ordered list items. Reserves the same head-indent column as
/// the bullet handler (the layout manager draws the number into it) and
/// serializes to an `N. ` line prefix indented three spaces per nesting level.
/// Depth rides in ENRMBlockRange.level, the number in ENRMBlockRange.ordinal.
@interface ENRMOrderedListBlockHandler : NSObject <ENRMBlockHandler>
@end

NS_ASSUME_NONNULL_END
