#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

NS_INLINE NSUInteger ENRMSortedInsertionIndex(NSArray *ranges, NSUInteger location,
                                              NSUInteger (^locationOfRange)(id range))
{
  NSUInteger index = 0;
  for (id existing in ranges) {
    if (locationOfRange(existing) > location)
      break;
    index++;
  }
  return index;
}

NS_INLINE void ENRMRemoveIndexesInReverse(NSMutableArray *array, NSMutableIndexSet *indexes)
{
  [indexes enumerateIndexesWithOptions:NSEnumerationReverse
                            usingBlock:^(NSUInteger idx, BOOL *stop) { [array removeObjectAtIndex:idx]; }];
}

/// paragraphRangeForRange: includes the line terminator; this strips it
/// to match the parser's content-only range convention.
NS_INLINE NSRange ENRMTrimLineTerminators(NSRange range, NSString *text)
{
  while (range.length > 0) {
    unichar last = [text characterAtIndex:NSMaxRange(range) - 1];
    if (last != '\n' && last != '\r') {
      break;
    }
    range.length--;
  }
  return range;
}

NS_ASSUME_NONNULL_END
