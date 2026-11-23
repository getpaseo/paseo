#import "ENRMFormattingStore.h"
#import "ENRMRangeEditAdjustment.h"
#import "ENRMRangeStoreUtils.h"

@implementation ENRMFormattingStore {
  NSMutableArray<ENRMFormattingRange *> *_ranges;
}

- (instancetype)init
{
  if (self = [super init]) {
    _ranges = [NSMutableArray array];
  }
  return self;
}

- (NSArray<ENRMFormattingRange *> *)allRanges
{
  return [_ranges copy];
}

- (NSArray<ENRMFormattingRange *> *)rangesOfType:(ENRMInputStyleType)type
{
  NSMutableArray<ENRMFormattingRange *> *result = [NSMutableArray array];
  for (ENRMFormattingRange *formattingRange in _ranges) {
    if (formattingRange.type == type) {
      [result addObject:formattingRange];
    }
  }
  return result;
}

- (void)setRanges:(NSArray<ENRMFormattingRange *> *)ranges
{
  _ranges =
      [[ranges sortedArrayUsingComparator:^NSComparisonResult(ENRMFormattingRange *first, ENRMFormattingRange *second) {
        if (first.range.location < second.range.location)
          return NSOrderedAscending;
        if (first.range.location > second.range.location)
          return NSOrderedDescending;
        return NSOrderedSame;
      }] mutableCopy];
}

- (void)clearAll
{
  [_ranges removeAllObjects];
}

- (nullable ENRMFormattingRange *)rangeOfType:(ENRMInputStyleType)type containingPosition:(NSUInteger)position
{
  for (ENRMFormattingRange *formattingRange in _ranges) {
    if (formattingRange.type != type)
      continue;
    if (position >= formattingRange.range.location && position < NSMaxRange(formattingRange.range)) {
      return formattingRange;
    }
  }
  return nil;
}

- (NSRange)selectionAdjustedForAtomicLinks:(NSRange)selection
{
  if (selection.length > 0) {
    NSUInteger start = selection.location;
    NSUInteger end = NSMaxRange(selection);
    ENRMFormattingRange *startLink = [self rangeOfType:ENRMInputStyleTypeLink containingPosition:start];
    if (startLink != nil) {
      start = MIN(start, startLink.range.location);
    }
    if (end > 0) {
      ENRMFormattingRange *endLink = [self rangeOfType:ENRMInputStyleTypeLink containingPosition:(end - 1)];
      if (endLink != nil) {
        end = MAX(end, NSMaxRange(endLink.range));
      }
    }
    return NSMakeRange(start, end - start);
  }
  ENRMFormattingRange *caretLink = [self rangeOfType:ENRMInputStyleTypeLink containingPosition:selection.location];
  if (caretLink != nil && selection.location > caretLink.range.location &&
      selection.location < NSMaxRange(caretLink.range)) {
    return NSMakeRange(NSMaxRange(caretLink.range), 0);
  }
  return selection;
}

- (BOOL)isStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position
{
  return [self rangeOfType:type containingPosition:position] != nil;
}

- (BOOL)isStyleActive:(ENRMInputStyleType)type inRange:(NSRange)range
{
  for (ENRMFormattingRange *formattingRange in _ranges) {
    if (formattingRange.type == type && NSIntersectionRange(formattingRange.range, range).length > 0) {
      return YES;
    }
  }
  return NO;
}

- (BOOL)isStyleAdjacentBefore:(ENRMInputStyleType)type position:(NSUInteger)position
{
  if (position == 0) {
    return NO;
  }
  return [self rangeOfType:type containingPosition:position] != nil || [self rangeOfType:type
                                                                           containingPosition:position - 1] != nil;
}

- (BOOL)isStyleFullyActive:(ENRMInputStyleType)type inRange:(NSRange)range
{
  NSUInteger pos = range.location;
  NSUInteger end = NSMaxRange(range);
  while (pos < end) {
    ENRMFormattingRange *match = [self rangeOfType:type containingPosition:pos];
    if (match == nil) {
      return NO;
    }
    pos = NSMaxRange(match.range);
  }
  return YES;
}

- (BOOL)toggleStyle:(ENRMInputStyleType)type
              inRange:(NSRange)range
    conflictingStyles:(NSSet<NSNumber *> *)conflictingStyles
{
  BOOL wasActive;
  if (range.length > 0) {
    wasActive = [self isStyleFullyActive:type inRange:range];
    if (wasActive) {
      [self removeType:type inRange:range];
    } else {
      for (NSNumber *conflict in conflictingStyles) {
        [self removeType:(ENRMInputStyleType)conflict.integerValue inRange:range];
      }
      [self addRange:[ENRMFormattingRange rangeWithType:type range:range]];
    }
  } else {
    wasActive = [self isStyleActive:type atPosition:range.location];
  }
  return wasActive;
}

- (BOOL)isToggleBlocked:(ENRMInputStyleType)type
             atPosition:(NSUInteger)position
         blockingStyles:(NSSet<NSNumber *> *)blockingStyles
{
  if (blockingStyles.count == 0) {
    return NO;
  }
  if ([self isStyleActive:type atPosition:position]) {
    return NO;
  }
  for (NSNumber *blocker in blockingStyles) {
    if ([self isStyleActive:(ENRMInputStyleType)blocker.integerValue atPosition:position]) {
      return YES;
    }
  }
  return NO;
}

- (void)addRange:(ENRMFormattingRange *)newRange
{
  NSMutableIndexSet *mergeIndexes = [NSMutableIndexSet indexSet];
  NSUInteger mergedStart = newRange.range.location;
  NSUInteger mergedEnd = NSMaxRange(newRange.range);

  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMFormattingRange *existing = _ranges[idx];
    if (existing.type != newRange.type)
      continue;

    NSUInteger existingEnd = NSMaxRange(existing.range);
    if (existing.range.location <= mergedEnd && existingEnd >= mergedStart) {
      mergedStart = MIN(mergedStart, existing.range.location);
      mergedEnd = MAX(mergedEnd, existingEnd);
      [mergeIndexes addIndex:idx];
    }
  }

  ENRMRemoveIndexesInReverse(_ranges, mergeIndexes);

  ENRMFormattingRange *merged = [ENRMFormattingRange rangeWithType:newRange.type
                                                             range:NSMakeRange(mergedStart, mergedEnd - mergedStart)
                                                               url:newRange.url];

  NSUInteger insertAt = ENRMSortedInsertionIndex(
      _ranges, merged.range.location, ^NSUInteger(id range) { return ((ENRMFormattingRange *)range).range.location; });
  [_ranges insertObject:merged atIndex:insertAt];
}

- (void)removeType:(ENRMInputStyleType)type inRange:(NSRange)removeRange
{
  NSMutableArray<ENRMFormattingRange *> *remainders = [NSMutableArray array];
  NSMutableIndexSet *indexesToRemove = [NSMutableIndexSet indexSet];

  NSUInteger removeStart = removeRange.location;
  NSUInteger removeEnd = NSMaxRange(removeRange);

  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMFormattingRange *existing = _ranges[idx];
    if (existing.type != type)
      continue;

    NSUInteger existingStart = existing.range.location;
    NSUInteger existingEnd = NSMaxRange(existing.range);

    if (existingEnd <= removeStart || existingStart >= removeEnd) {
      continue;
    }

    [indexesToRemove addIndex:idx];

    if (existingStart < removeStart) {
      [remainders addObject:[ENRMFormattingRange rangeWithType:type
                                                         range:NSMakeRange(existingStart, removeStart - existingStart)
                                                           url:existing.url]];
    }
    if (existingEnd > removeEnd) {
      [remainders addObject:[ENRMFormattingRange rangeWithType:type
                                                         range:NSMakeRange(removeEnd, existingEnd - removeEnd)
                                                           url:existing.url]];
    }
  }

  ENRMRemoveIndexesInReverse(_ranges, indexesToRemove);

  // Remainders are fragments of a just-removed range and cannot overlap others.
  for (ENRMFormattingRange *remainder in remainders) {
    NSUInteger insertAt = ENRMSortedInsertionIndex(_ranges, remainder.range.location, ^NSUInteger(id range) {
      return ((ENRMFormattingRange *)range).range.location;
    });
    [_ranges insertObject:remainder atIndex:insertAt];
  }
}

- (void)removeRange:(ENRMFormattingRange *)range
{
  [_ranges removeObject:range];
}

- (void)adjustForEditAtLocation:(NSUInteger)editLocation
                  deletedLength:(NSUInteger)deletedLength
                 insertedLength:(NSUInteger)insertedLength
{
  if (deletedLength == 0 && insertedLength == 0)
    return;

  NSMutableIndexSet *indexesToRemove = [NSMutableIndexSet indexSet];

  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMFormattingRange *formattingRange = _ranges[idx];
    BOOL inheritsReplacement = formattingRange.type != ENRMInputStyleTypeLink;
    ENRMAdjustedRange adjusted = ENRMAdjustRangeForEdit(formattingRange.range, editLocation, deletedLength,
                                                        insertedLength, inheritsReplacement, NO);
    formattingRange.range = adjusted.range;
    if (adjusted.shouldRemove) {
      [indexesToRemove addIndex:idx];
    }
  }

  ENRMRemoveIndexesInReverse(_ranges, indexesToRemove);

  NSMutableIndexSet *emptyIndexes = [NSMutableIndexSet indexSet];
  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    if (_ranges[idx].range.length == 0) {
      [emptyIndexes addIndex:idx];
    }
  }
  if (emptyIndexes.count > 0) {
    ENRMRemoveIndexesInReverse(_ranges, emptyIndexes);
  }

  [self coalesceAdjacentSameTypeRanges];
}

/// Merge same-type (and same-url) ranges left adjacent or overlapping by an
/// edit — e.g. deleting the space in "**foo** **bar**" leaves two touching
/// bold ranges that would serialize as "**foo****bar**". `addRange:` keeps
/// this invariant on insert; the edit path must too.
- (void)coalesceAdjacentSameTypeRanges
{
  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMFormattingRange *current = _ranges[idx];
    NSUInteger next = idx + 1;
    while (next < _ranges.count && _ranges[next].range.location <= NSMaxRange(current.range)) {
      ENRMFormattingRange *candidate = _ranges[next];
      BOOL sameUrl = (current.url == candidate.url) || [current.url isEqualToString:candidate.url];
      if (candidate.type == current.type && sameUrl) {
        NSUInteger mergedEnd = MAX(NSMaxRange(current.range), NSMaxRange(candidate.range));
        current.range = NSMakeRange(current.range.location, mergedEnd - current.range.location);
        [_ranges removeObjectAtIndex:next];
      } else {
        next++;
      }
    }
  }
}

@end
