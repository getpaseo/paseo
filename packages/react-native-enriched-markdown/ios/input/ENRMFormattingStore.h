#pragma once

#import "ENRMFormattingRange.h"

NS_ASSUME_NONNULL_BEGIN

@interface ENRMFormattingStore : NSObject

@property (nonatomic, readonly) NSArray<ENRMFormattingRange *> *allRanges;

- (void)setRanges:(NSArray<ENRMFormattingRange *> *)ranges;
- (void)clearAll;

- (nullable ENRMFormattingRange *)rangeOfType:(ENRMInputStyleType)type containingPosition:(NSUInteger)position;
- (BOOL)isStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position;
- (BOOL)isStyleActive:(ENRMInputStyleType)type inRange:(NSRange)range;
- (BOOL)isStyleAdjacentBefore:(ENRMInputStyleType)type position:(NSUInteger)position;
- (NSArray<ENRMFormattingRange *> *)rangesOfType:(ENRMInputStyleType)type;

/// Snaps a selection so it never partially overlaps an atomic link: a partial selection expands to
/// the whole link, a caret inside a link moves to its end (unchanged when no adjustment is needed).
- (NSRange)selectionAdjustedForAtomicLinks:(NSRange)selection;

/// YES when the entire `range` is covered by adjacent/overlapping ranges of `type`.
- (BOOL)isStyleFullyActive:(ENRMInputStyleType)type inRange:(NSRange)range;

/// Toggles `type` on `range`. For a selection (length > 0), removes the style
/// when fully active, otherwise strips `conflictingStyles` and adds it.
/// For a caret (length == 0), reports the current state without mutating.
/// Returns YES when the style was active (removed / pending removal).
- (BOOL)toggleStyle:(ENRMInputStyleType)type
              inRange:(NSRange)range
    conflictingStyles:(NSSet<NSNumber *> *)conflictingStyles;

/// YES when toggling `type` ON at `position` should be refused because one of
/// the `blockingStyles` is active there. Toggling OFF is never blocked.
- (BOOL)isToggleBlocked:(ENRMInputStyleType)type
             atPosition:(NSUInteger)position
         blockingStyles:(NSSet<NSNumber *> *)blockingStyles;

- (void)addRange:(ENRMFormattingRange *)range;
- (void)removeType:(ENRMInputStyleType)type inRange:(NSRange)range;
- (void)removeRange:(ENRMFormattingRange *)range;

- (void)adjustForEditAtLocation:(NSUInteger)location
                  deletedLength:(NSUInteger)deletedLength
                 insertedLength:(NSUInteger)insertedLength;

@end

NS_ASSUME_NONNULL_END
