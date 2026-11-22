#import "ENRMBlockStore.h"
#import "ENRMRangeEditAdjustment.h"
#import "ENRMRangeStoreUtils.h"

/// Expands a selection to cover whole paragraphs (line-scoped block boundaries).
/// Clamps unconditionally so out-of-bounds input can't reach
/// paragraphRangeForRange: (which raises on an invalid range).
static NSRange paragraphBoundsForRange(NSRange range, NSString *text)
{
  if (text.length == 0) {
    return NSMakeRange(0, 0);
  }
  NSUInteger location = MIN(range.location, text.length);
  NSUInteger length = MIN(range.length, text.length - location);
  return [text paragraphRangeForRange:NSMakeRange(location, length)];
}

@implementation ENRMBlockStore {
  NSMutableArray<ENRMBlockRange *> *_ranges;
}

- (instancetype)init
{
  if (self = [super init]) {
    _ranges = [NSMutableArray array];
  }
  return self;
}

- (NSArray<ENRMBlockRange *> *)allRanges
{
  return [_ranges copy];
}

- (nullable ENRMBlockRange *)blockStartingAtLocation:(NSUInteger)location
{
  NSInteger lo = 0;
  NSInteger hi = (NSInteger)_ranges.count - 1;
  while (lo <= hi) {
    NSInteger mid = (lo + hi) / 2;
    NSUInteger start = _ranges[(NSUInteger)mid].range.location;
    if (start < location) {
      lo = mid + 1;
    } else if (start > location) {
      hi = mid - 1;
    } else {
      return _ranges[(NSUInteger)mid];
    }
  }
  return nil;
}

// Incoming ranges are trusted to be non-overlapping and line-scoped — the
// parser owns that invariant (md4c block structure never overlaps at the same
// nesting level, and nested containers are not yet mapped). Revisit enforcement
// here if a container block type (list, blockquote) is added.
- (void)setRanges:(NSArray<ENRMBlockRange *> *)ranges
{
  _ranges = [[ranges sortedArrayUsingComparator:^NSComparisonResult(ENRMBlockRange *first, ENRMBlockRange *second) {
    if (first.range.location < second.range.location)
      return NSOrderedAscending;
    if (first.range.location > second.range.location)
      return NSOrderedDescending;
    return NSOrderedSame;
  }] mutableCopy];
  [self recomputeListMetadata];
}

- (void)clearAll
{
  [_ranges removeAllObjects];
}

/// Drops any stored block overlapping `paragraphRange` so a replacement can be
/// inserted cleanly. Blocks are line-scoped and never partially overlap, so a
/// touched block is removed wholesale.
- (void)removeBlocksOverlappingRange:(NSRange)paragraphRange
{
  NSUInteger removeStart = paragraphRange.location;
  NSUInteger removeEnd = NSMaxRange(paragraphRange);
  NSMutableIndexSet *indexesToRemove = [NSMutableIndexSet indexSet];

  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMBlockRange *existing = _ranges[idx];
    NSUInteger existingStart = existing.range.location;
    NSUInteger existingEnd = NSMaxRange(existing.range);

    // A zero-length anchor occupies a point, so the half-open overlap test
    // never matches it; drop one whose anchor lies within the removal bounds.
    if (existing.range.length == 0) {
      if (existingStart >= removeStart && existingStart <= removeEnd) {
        [indexesToRemove addIndex:idx];
      }
      continue;
    }

    if (existingEnd <= removeStart || existingStart >= removeEnd) {
      continue;
    }
    [indexesToRemove addIndex:idx];
  }

  ENRMRemoveIndexesInReverse(_ranges, indexesToRemove);
}

- (void)setBlockType:(ENRMInputBlockType)type
                level:(NSInteger)level
    forParagraphRange:(NSRange)range
               inText:(NSString *)text
{
  NSRange paragraphRange = paragraphBoundsForRange(range, text);
  [self removeBlocksOverlappingRange:paragraphRange];

  paragraphRange = ENRMTrimLineTerminators(paragraphRange, text);

  if (paragraphRange.length == 0 && !ENRMBlockTypePersistsWhenEmpty(type)) {
    return;
  }

  ENRMBlockRange *blockRange = [ENRMBlockRange rangeWithType:type range:paragraphRange level:level];
  NSUInteger insertAt = ENRMSortedInsertionIndex(
      _ranges, blockRange.range.location, ^NSUInteger(id range) { return ((ENRMBlockRange *)range).range.location; });
  [_ranges insertObject:blockRange atIndex:insertAt];
}

- (void)removeBlockInParagraphRange:(NSRange)range inText:(NSString *)text
{
  NSRange paragraphRange = paragraphBoundsForRange(range, text);
  [self removeBlocksOverlappingRange:paragraphRange];
}

- (void)adjustForEditAtLocation:(NSUInteger)editLocation
                  deletedLength:(NSUInteger)deletedLength
                 insertedLength:(NSUInteger)insertedLength
{
  if (deletedLength == 0 && insertedLength == 0)
    return;

  NSUInteger deleteEnd = editLocation + deletedLength;
  NSMutableIndexSet *indexesToRemove = [NSMutableIndexSet indexSet];

  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMBlockRange *blockRange = _ranges[idx];
    BOOL persists = ENRMBlockTypePersistsWhenEmpty(blockRange.type);

    // Zero-length anchors don't follow the shared adjustment: one at the edit
    // location stays put (normalize grows it over the typed text), one past
    // the edit shifts with it, one inside the deletion is dropped.
    if (blockRange.range.length == 0) {
      if (!persists) {
        [indexesToRemove addIndex:idx];
      } else if (blockRange.range.location >= deleteEnd && blockRange.range.location > editLocation) {
        blockRange.range = NSMakeRange(blockRange.range.location - deletedLength + insertedLength, 0);
      } else if (blockRange.range.location > editLocation) {
        [indexesToRemove addIndex:idx]; // anchor sat inside the deleted region
      }
      continue;
    }

    ENRMAdjustedRange adjusted = ENRMAdjustRangeForEdit(blockRange.range, editLocation, deletedLength, insertedLength,
                                                        /* inheritsReplacementAtStart */ YES,
                                                        /* growsAtStartOnInsert */ YES);
    if (adjusted.shouldRemove) {
      // A persisting block deleted exactly to its end collapses to a zero-length
      // anchor (the line's newline survived, so the line stays the block); a
      // deletion running past its end removed the line, so drop the block with it.
      if (persists && NSMaxRange(blockRange.range) == deleteEnd && blockRange.range.location >= editLocation) {
        blockRange.range = NSMakeRange(editLocation, 0);
      } else {
        [indexesToRemove addIndex:idx];
      }
      continue;
    }
    blockRange.range = adjusted.range;
  }

  ENRMRemoveIndexesInReverse(_ranges, indexesToRemove);

  // Prune zero-length ranges, but keep zero-length persisting blocks: they anchor
  // an emptied-but-still-present heading/bullet line (see the collapse rule above).
  NSMutableIndexSet *emptyIndexes = [NSMutableIndexSet indexSet];
  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMBlockRange *range = _ranges[idx];
    if (range.range.length == 0 && !ENRMBlockTypePersistsWhenEmpty(range.type)) {
      [emptyIndexes addIndex:idx];
    }
  }
  if (emptyIndexes.count > 0) {
    ENRMRemoveIndexesInReverse(_ranges, emptyIndexes);
  }
}

- (void)normalizeToLineBoundsInText:(NSString *)text
{
  if (_ranges.count == 0) {
    return;
  }

  NSMutableIndexSet *indexesToRemove = [NSMutableIndexSet indexSet];
  NSInteger previousEnd = -1;

  for (NSUInteger idx = 0; idx < _ranges.count; idx++) {
    ENRMBlockRange *blockRange = _ranges[idx];
    NSRange lineRange = paragraphBoundsForRange(NSMakeRange(blockRange.range.location, 0), text);

    lineRange = ENRMTrimLineTerminators(lineRange, text);

    BOOL emptyLine = lineRange.length == 0;
    if ((emptyLine && !ENRMBlockTypePersistsWhenEmpty(blockRange.type)) ||
        (NSInteger)lineRange.location <= previousEnd) {
      // Dedup: drop a range that resolves to an already-claimed paragraph. This is a
      // legitimate self-heal path (a heading anchor and the block it merges into can
      // briefly share a start after a line-join), so it is deliberately silent — it
      // cannot distinguish that benign case from genuine corruption, so it does not
      // assert here.
      [indexesToRemove addIndex:idx];
      continue;
    }

    blockRange.range = lineRange;
    previousEnd = (NSInteger)NSMaxRange(lineRange);
  }

  ENRMRemoveIndexesInReverse(_ranges, indexesToRemove);
  [self recomputeListMetadata];
}

/// Clamps list depths to valid ancestry (an item nests at most one level under
/// the previous adjacent list item — CommonMark cannot represent orphan nesting)
/// and renumbers ordered items among their adjacent same-depth, same-type run.
- (void)recomputeListMetadata
{
  NSInteger prevEnd = -2;
  NSInteger prevDepth = -1;
  NSInteger counters[kENRMMaxListDepth + 2];
  ENRMInputBlockType counterTypes[kENRMMaxListDepth + 2];
  memset(counters, 0, sizeof(counters));
  memset(counterTypes, 0, sizeof(counterTypes));

  for (ENRMBlockRange *blockRange in _ranges) {
    if (!ENRMBlockTypeIsListItem(blockRange.type)) {
      prevDepth = -1;
      continue;
    }
    BOOL adjacent = prevDepth >= 0 && (NSInteger)blockRange.range.location == prevEnd + 1;
    if (!adjacent) {
      memset(counters, 0, sizeof(counters));
      memset(counterTypes, 0, sizeof(counterTypes));
    }
    // Coerce into [0, kENRMMaxListDepth] before ancestry-clamping: parser and
    // indent commands cap their depths, but this pass indexes the counter
    // arrays by depth, so an out-of-bounds level must never survive it.
    NSInteger maxDepth = MIN(adjacent ? prevDepth + 1 : 0, kENRMMaxListDepth);
    if (blockRange.level > maxDepth) {
      blockRange.level = maxDepth;
    } else if (blockRange.level < 0) {
      blockRange.level = 0;
    }
    NSInteger depth = blockRange.level;
    for (NSInteger i = depth + 1; i <= kENRMMaxListDepth + 1; i++) {
      counters[i] = 0;
      counterTypes[i] = (ENRMInputBlockType)0;
    }
    if (counterTypes[depth] != blockRange.type) {
      counters[depth] = 0;
      counterTypes[depth] = blockRange.type;
    }
    counters[depth]++;
    blockRange.ordinal = counters[depth];
    prevEnd = (NSInteger)NSMaxRange(blockRange.range);
    prevDepth = blockRange.level;
  }
}

@end
