#pragma once

#import "ENRMBlockRange.h"
#import "ENRMFormattingRange.h"
#import "ENRMInputFormatterStyle.h"

NS_ASSUME_NONNULL_BEGIN

@protocol ENRMStyleHandler;
@protocol ENRMBlockHandler;

@interface ENRMInputFormatter : NSObject

- (nullable id<ENRMStyleHandler>)handlerForStyleType:(ENRMInputStyleType)type;
- (nullable id<ENRMBlockHandler>)handlerForBlockType:(ENRMInputBlockType)type;

- (void)applyFormattingRanges:(NSArray<ENRMFormattingRange *> *)ranges
                   toTextView:(ENRMPlatformTextView *)textView
                        style:(ENRMInputFormatterStyle *)style;

/// Same as above, but resets and re-applies attributes only within `scope`
/// (ranges straddling the boundary are clipped — attributes outside the scope
/// are already consistent because they move with the text on edits). Pass the
/// full text range for a wholesale re-apply (import / style change).
- (void)applyFormattingRanges:(NSArray<ENRMFormattingRange *> *)ranges
                   toTextView:(ENRMPlatformTextView *)textView
                        style:(ENRMInputFormatterStyle *)style
                scopedToRange:(NSRange)scope;

/// Applies paragraph-level attributes for each block range via its handler,
/// after first stripping the attributes applied on the previous pass (so
/// removed blocks don't leave stale paragraph styling behind). With no
/// handlers registered (PR1) this is a no-op.
- (void)applyBlockRanges:(NSArray<ENRMBlockRange *> *)blockRanges
              toTextView:(ENRMPlatformTextView *)textView
                   style:(ENRMInputFormatterStyle *)style;

/// Same as above, scoped: strips markers only within `scope` and re-applies
/// only the block ranges intersecting it. `scope` must cover whole lines
/// (blocks are line-scoped) — pass a line-expanded edit window.
- (void)applyBlockRanges:(NSArray<ENRMBlockRange *> *)blockRanges
              toTextView:(ENRMPlatformTextView *)textView
                   style:(ENRMInputFormatterStyle *)style
           scopedToRange:(NSRange)scope;

@end

NS_ASSUME_NONNULL_END
