#pragma once

#import "ENRMBlockRange.h"

NS_ASSUME_NONNULL_BEGIN

/// Stores the block-level (paragraph-scoped) ranges for the editor, mirroring
/// ENRMFormattingStore. Unlike inline ranges, block ranges never overlap: at
/// most one block covers any given paragraph, and ranges are kept normalized to
/// whole-line boundaries.
@interface ENRMBlockStore : NSObject

@property (nonatomic, readonly) NSArray<ENRMBlockRange *> *allRanges;

/// Returns the block whose paragraph starts exactly at `location`, or nil.
/// Ranges are kept sorted by start, so this is an O(log n) binary search — the
/// single lookup callers use instead of linearly scanning `allRanges`. Relies on
/// the one-block-per-paragraph invariant (paragraph starts are unique).
- (nullable ENRMBlockRange *)blockStartingAtLocation:(NSUInteger)location;

- (void)setRanges:(NSArray<ENRMBlockRange *> *)ranges;
- (void)clearAll;

/// Sets/replaces the block on every paragraph the given range touches, expanding
/// to whole-line boundaries within `text`. Removes any block previously covering
/// those paragraphs.
- (void)setBlockType:(ENRMInputBlockType)type
                level:(NSInteger)level
    forParagraphRange:(NSRange)range
               inText:(NSString *)text;

/// Clears any block on the paragraphs the given range touches (reverting them to
/// the implicit paragraph default).
- (void)removeBlockInParagraphRange:(NSRange)range inText:(NSString *)text;

/// Shifts/clips block ranges to follow a text edit (shared
/// ENRMRangeEditAdjustment classification), with heading persistence: a heading
/// deleted exactly to its end collapses to a zero-length anchor at the edit
/// location (its line survives), and existing anchors shift/keep/drop with
/// their line.
- (void)adjustForEditAtLocation:(NSUInteger)location
                  deletedLength:(NSUInteger)deletedLength
                 insertedLength:(NSUInteger)insertedLength;

/// Snaps every stored range to the line bounds of its start position.
/// Absorbs edge-typed chars, clips split ranges to first line, drops
/// duplicates. On an empty line a heading persists as a zero-length anchor;
/// any other collapsed range is dropped. List depths are clamped so an item
/// nests at most one level under the previous adjacent item (CommonMark cannot
/// represent orphan nesting). Call after adjustForEditAtLocation: once text is
/// final. Idempotent.
- (void)normalizeToLineBoundsInText:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
