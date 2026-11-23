#pragma once

#import "ENRMBlockRange.h"
#import "ENRMFormattingRange.h"
#import "ENRMInputStyledRange.h"
#import <Foundation/Foundation.h>
#include <string>

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  BOOL bold;
  BOOL italic;
  BOOL underline;
  BOOL strikethrough;
  BOOL spoiler;
  BOOL link;
  /// URL of the link at the selection. Note that this can be an empty string
  /// for a link with an empty URL.
  std::string linkDestination;
  NSInteger headingLevel;
  BOOL unorderedList;
  BOOL orderedList;
  NSInteger listDepth;
} ENRMInputStyleSnapshot;

@protocol ENRMInputStyleStateDataSource <NSObject>

- (NSRange)selectedRange;
- (BOOL)isEffectiveStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position;
- (BOOL)isStyleActive:(ENRMInputStyleType)type inRange:(NSRange)range;
- (NSInteger)headingLevelForCursorParagraph;
- (nullable ENRMBlockRange *)listBlockForCursorParagraph;
- (nullable ENRMFormattingRange *)linkForSelection:(NSRange)selection;

@end

@interface ENRMInputStyleStateBuilder : NSObject

+ (ENRMInputStyleSnapshot)snapshotAtCurrentCursor:(id<ENRMInputStyleStateDataSource>)dataSource;

+ (ENRMInputStyleSnapshot)snapshotForRange:(NSRange)range dataSource:(id<ENRMInputStyleStateDataSource>)dataSource;

@end

NS_ASSUME_NONNULL_END
