#pragma once

#import "ENRMInputBlockType.h"
#import <Foundation/Foundation.h>

@class ENRMBlockStore;
@class ENRMBlockRange;

NS_ASSUME_NONNULL_BEGIN

/// Result of a depth-change operation.
typedef NS_ENUM(NSInteger, ENRMDepthChangeResult) {
  ENRMDepthChangeResultChanged,
  ENRMDepthChangeResultStartedList,
  ENRMDepthChangeResultExitedList,
  ENRMDepthChangeResultNoOp,
};

/// Encapsulates block-editing operations: toggling block types, adjusting list
/// depth, and querying the block at a given position. The view delegates here
/// and applies UI-level consequences (formatting, anchor sync, typing
/// attributes) based on the returned result.
///
/// All mutating methods normalize stores to line bounds before returning, so the
/// caller can re-stamp block spans immediately.
@interface ENRMBlockEditCoordinator : NSObject

- (instancetype)initWithBlockStore:(ENRMBlockStore *)blockStore;

// ── Queries ──────────────────────────────────────────────────────────

/// The block owning the paragraph at `position`, or nil.
- (nullable ENRMBlockRange *)blockAtPosition:(NSUInteger)position inText:(NSString *)text;

/// The list-item block at `position`, or nil if the paragraph is not a list item.
- (nullable ENRMBlockRange *)listBlockAtPosition:(NSUInteger)position inText:(NSString *)text;

/// Heading level (1-6) at `position`, or 0 for non-heading paragraphs.
- (NSInteger)headingLevelAtPosition:(NSUInteger)position inText:(NSString *)text;

/// Whether the paragraph at `position` is a list item of `type`, and its depth.
- (BOOL)listStateOfType:(ENRMInputBlockType)type
             atPosition:(NSUInteger)position
                 inText:(NSString *)text
                  depth:(nullable NSInteger *)outDepth;

// ── Mutations ────────────────────────────────────────────────────────

/// Toggles `type` at `level` on the paragraphs the selection touches.
/// Returns YES when the block was already active (i.e. it was turned off).
- (BOOL)toggleBlockType:(ENRMInputBlockType)type
                  level:(NSInteger)level
         selectionRange:(NSRange)selection
                 inText:(NSString *)text;

/// Toggles a list of `type` on the selection.
/// Returns YES when the list was turned off.
- (BOOL)toggleListType:(ENRMInputBlockType)type
        cursorPosition:(NSUInteger)cursorPos
        selectionRange:(NSRange)selection
                inText:(NSString *)text;

/// Adjusts list depth by `delta` on the selected lines.
- (ENRMDepthChangeResult)changeDepthBy:(NSInteger)delta
                        cursorPosition:(NSUInteger)cursorPos
                        selectionRange:(NSRange)selection
                                inText:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
