#pragma once

#import "ENRMFormattingRange.h"
#import "ENRMFormattingStore.h"
#import <Foundation/Foundation.h>

@class AutoLinkDetector;

NS_ASSUME_NONNULL_BEGIN

@protocol ENRMAutoLinkDetecting <NSObject>
- (void)clearAutoLinkInRange:(NSRange)range;
@end

@interface ENRMLinkCoordinator : NSObject

- (instancetype)initWithFormattingStore:(ENRMFormattingStore *)formattingStore
                       autoLinkDetector:(id<ENRMAutoLinkDetecting>)autoLinkDetector;

- (NSString *)sanitizeURL:(NSString *)url;

/// The link a caret or selection refers to, shared by everything that acts on
/// "the current link" (style state, the link prompt, setting and removing a
/// link) so they always agree. For a selection it is the link containing the
/// first selected character. For a collapsed caret it is the link the caret is
/// inside or right after: ranges are half-open, and the caret often lands at
/// NSMaxRange(link) after tapping a link.
- (nullable ENRMFormattingRange *)linkForSelection:(NSRange)selection;

/// Updates the URL of the link at the selection if the selection lies within
/// it, or otherwise adds a link over a non-empty selection. Returns YES if a
/// mutation occurred.
- (BOOL)setLinkURL:(NSString *)url forSelection:(NSRange)selection;

/// Removes the link at the selection. Returns YES if a link was found and removed.
- (BOOL)removeLinkForSelection:(NSRange)selection;

/// Returns the link range containing `position - 1`, for atomic link deletion.
- (nullable ENRMFormattingRange *)linkRangeForDeletionAtPosition:(NSUInteger)position;

@end

NS_ASSUME_NONNULL_END
