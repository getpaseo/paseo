#import "ENRMBlockEditCoordinator.h"
#import "ENRMBlockRange.h"
#import "ENRMBlockStore.h"

@implementation ENRMBlockEditCoordinator {
  ENRMBlockStore *_blockStore;
}

- (instancetype)initWithBlockStore:(ENRMBlockStore *)blockStore
{
  self = [super init];
  if (self) {
    _blockStore = blockStore;
  }
  return self;
}

// ── Queries ──────────────────────────────────────────────────────────

- (nullable ENRMBlockRange *)blockAtPosition:(NSUInteger)position inText:(NSString *)text
{
  if (position > text.length) {
    return nil;
  }
  NSRange paragraph = [text paragraphRangeForRange:NSMakeRange(position, 0)];
  return [_blockStore blockStartingAtLocation:paragraph.location];
}

- (nullable ENRMBlockRange *)listBlockAtPosition:(NSUInteger)position inText:(NSString *)text
{
  ENRMBlockRange *block = [self blockAtPosition:position inText:text];
  return (block != nil && ENRMBlockTypeIsListItem(block.type)) ? block : nil;
}

- (NSInteger)headingLevelAtPosition:(NSUInteger)position inText:(NSString *)text
{
  ENRMBlockRange *block = [self blockAtPosition:position inText:text];
  return block != nil ? ENRMHeadingLevelForBlockType(block.type) : 0;
}

- (BOOL)listStateOfType:(ENRMInputBlockType)type
             atPosition:(NSUInteger)position
                 inText:(NSString *)text
                  depth:(nullable NSInteger *)outDepth
{
  ENRMBlockRange *block = [self listBlockAtPosition:position inText:text];
  BOOL match = block != nil && block.type == type;
  if (outDepth) {
    *outDepth = match ? block.level : 0;
  }
  return match;
}

// ── Mutations ────────────────────────────────────────────────────────

- (BOOL)toggleBlockType:(ENRMInputBlockType)type
                  level:(NSInteger)level
         selectionRange:(NSRange)selection
                 inText:(NSString *)text
{
  NSRange paragraphRange = [text paragraphRangeForRange:selection];

  ENRMBlockRange *current = [_blockStore blockStartingAtLocation:paragraphRange.location];
  BOOL alreadyActive = current != nil && current.type == type;

  if (alreadyActive) {
    [_blockStore removeBlockInParagraphRange:paragraphRange inText:text];
  } else if (paragraphRange.length == 0) {
    NSInteger resolvedLevel = level;
    if (ENRMBlockTypeIsListItem(type) && current != nil && ENRMBlockTypeIsListItem(current.type)) {
      resolvedLevel = current.level;
    }
    [_blockStore setBlockType:type level:resolvedLevel forParagraphRange:paragraphRange inText:text];
  } else {
    [text
        enumerateSubstringsInRange:paragraphRange
                           options:NSStringEnumerationByParagraphs | NSStringEnumerationSubstringNotRequired
                        usingBlock:^(NSString *substring, NSRange substringRange, NSRange enclosingRange, BOOL *stop) {
                          NSInteger paragraphLevel = level;
                          if (ENRMBlockTypeIsListItem(type)) {
                            ENRMBlockRange *existing = [self listBlockAtPosition:substringRange.location inText:text];
                            if (existing != nil) {
                              paragraphLevel = existing.level;
                            }
                          }
                          [self->_blockStore setBlockType:type
                                                    level:paragraphLevel
                                        forParagraphRange:substringRange
                                                   inText:text];
                        }];
  }

  [_blockStore normalizeToLineBoundsInText:text];
  return alreadyActive;
}

- (BOOL)toggleListType:(ENRMInputBlockType)type
        cursorPosition:(NSUInteger)cursorPos
        selectionRange:(NSRange)selection
                inText:(NSString *)text
{
  ENRMBlockRange *cursorBlock = [self listBlockAtPosition:cursorPos inText:text];
  BOOL turningOff = cursorBlock != nil && cursorBlock.type == type;
  NSRange paragraphRange = [text paragraphRangeForRange:selection];

  if (turningOff) {
    if (paragraphRange.length == 0) {
      [_blockStore removeBlockInParagraphRange:paragraphRange inText:text];
    } else {
      [text enumerateSubstringsInRange:paragraphRange
                               options:NSStringEnumerationByParagraphs | NSStringEnumerationSubstringNotRequired
                            usingBlock:^(NSString *substring, NSRange substringRange, NSRange enclosingRange,
                                         BOOL *stop) {
                              [self->_blockStore removeBlockInParagraphRange:substringRange inText:text];
                            }];
    }
  } else {
    if (paragraphRange.length == 0) {
      NSInteger existingLevel = 0;
      ENRMBlockRange *existing = [self listBlockAtPosition:paragraphRange.location inText:text];
      if (existing != nil) {
        existingLevel = existing.level;
      }
      [_blockStore setBlockType:type level:existingLevel forParagraphRange:paragraphRange inText:text];
    } else {
      [text enumerateSubstringsInRange:paragraphRange
                               options:NSStringEnumerationByParagraphs | NSStringEnumerationSubstringNotRequired
                            usingBlock:^(NSString *substring, NSRange substringRange, NSRange enclosingRange,
                                         BOOL *stop) {
                              NSInteger existingLevel = 0;
                              ENRMBlockRange *existing = [self listBlockAtPosition:substringRange.location inText:text];
                              if (existing != nil) {
                                existingLevel = existing.level;
                              }
                              [self->_blockStore setBlockType:type
                                                        level:existingLevel
                                            forParagraphRange:substringRange
                                                       inText:text];
                            }];
    }
  }

  [_blockStore normalizeToLineBoundsInText:text];
  return turningOff;
}

- (ENRMDepthChangeResult)changeDepthBy:(NSInteger)delta
                        cursorPosition:(NSUInteger)cursorPos
                        selectionRange:(NSRange)selection
                                inText:(NSString *)text
{
  ENRMBlockRange *cursorBlock = [self listBlockAtPosition:cursorPos inText:text];
  if (cursorBlock == nil) {
    if (delta > 0 && [self headingLevelAtPosition:cursorPos inText:text] == 0) {
      [self toggleListType:ENRMInputBlockTypeUnorderedListItem
            cursorPosition:cursorPos
            selectionRange:selection
                    inText:text];
      return ENRMDepthChangeResultStartedList;
    }
    return ENRMDepthChangeResultNoOp;
  }

  if (delta < 0 && cursorBlock.level == 0) {
    [self toggleListType:cursorBlock.type cursorPosition:cursorPos selectionRange:selection inText:text];
    return ENRMDepthChangeResultExitedList;
  }

  NSRange paragraphRange = [text paragraphRangeForRange:selection];

  if (paragraphRange.length == 0) {
    NSInteger newDepth = MIN(MAX(cursorBlock.level + delta, (NSInteger)0), kENRMMaxListDepth);
    [_blockStore setBlockType:cursorBlock.type level:newDepth forParagraphRange:paragraphRange inText:text];
  } else {
    [text
        enumerateSubstringsInRange:paragraphRange
                           options:NSStringEnumerationByParagraphs | NSStringEnumerationSubstringNotRequired
                        usingBlock:^(NSString *substring, NSRange substringRange, NSRange enclosingRange, BOOL *stop) {
                          ENRMBlockRange *block = [self listBlockAtPosition:substringRange.location inText:text];
                          if (block == nil) {
                            return;
                          }
                          NSInteger newDepth = MIN(MAX(block.level + delta, (NSInteger)0), kENRMMaxListDepth);
                          [self->_blockStore setBlockType:block.type
                                                    level:newDepth
                                        forParagraphRange:substringRange
                                                   inText:text];
                        }];
  }

  [_blockStore normalizeToLineBoundsInText:text];
  return ENRMDepthChangeResultChanged;
}

@end
