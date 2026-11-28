#import "ENRMEditPipeline.h"
#import "ENRMBlockHandler.h"
#import "ENRMBlockStore.h"
#import "ENRMDetectorPipeline.h"
#import "ENRMFormattingRange.h"
#import "ENRMFormattingStore.h"
#import "ENRMInputFormatter.h"
#import "ENRMUIKit.h"

@implementation ENRMEditContext

- (instancetype)initWithEditLocation:(NSUInteger)editLocation
                       deletedLength:(NSUInteger)deletedLength
                      insertedLength:(NSUInteger)insertedLength
              preEditReplacedNewline:(BOOL)preEditReplacedNewline
                    preEditBlockType:(ENRMInputBlockType)preEditBlockType
                   preEditBlockLevel:(NSInteger)preEditBlockLevel
            preEditParagraphWasEmpty:(BOOL)preEditParagraphWasEmpty
                       pendingStyles:(NSSet<NSNumber *> *)pendingStyles
                pendingStyleRemovals:(NSSet<NSNumber *> *)pendingStyleRemovals
{
  if (self = [super init]) {
    _editLocation = editLocation;
    _deletedLength = deletedLength;
    _insertedLength = insertedLength;
    _preEditReplacedNewline = preEditReplacedNewline;
    _preEditBlockType = preEditBlockType;
    _preEditBlockLevel = preEditBlockLevel;
    _preEditParagraphWasEmpty = preEditParagraphWasEmpty;
    _pendingStyles = [pendingStyles copy];
    _pendingStyleRemovals = [pendingStyleRemovals copy];
  }
  return self;
}

@end

@implementation ENRMEditPipeline {
  ENRMFormattingStore *_formattingStore;
  ENRMBlockStore *_blockStore;
  ENRMInputFormatter *_formatter;
  ENRMDetectorPipeline *_detectorPipeline;
  __weak id<ENRMEditPipelineHost> _host;
}

- (instancetype)initWithFormattingStore:(ENRMFormattingStore *)formattingStore
                             blockStore:(ENRMBlockStore *)blockStore
                              formatter:(ENRMInputFormatter *)formatter
                       detectorPipeline:(ENRMDetectorPipeline *)detectorPipeline
                                   host:(id<ENRMEditPipelineHost>)host
{
  if (self = [super init]) {
    _formattingStore = formattingStore;
    _blockStore = blockStore;
    _formatter = formatter;
    _detectorPipeline = detectorPipeline;
    _host = host;
  }
  return self;
}

#pragma mark - Public API

- (BOOL)processTextChangeWithContext:(ENRMEditContext *)context
{
  NSUInteger editLocation = context.editLocation;
  NSUInteger insertedLength = context.insertedLength;

  [self adjustStoresForEditAtLocation:editLocation deletedLength:context.deletedLength insertedLength:insertedLength];

  NSString *plainText = [_host plainText];

  if (insertedLength > 0) {
    BOOL insertedHasGlyphContent = [self insertedHasGlyphContentAtLocation:editLocation
                                                                    length:insertedLength
                                                                      text:plainText];
    [self applyPendingStylesWithContext:context plainText:plainText hasGlyphContent:insertedHasGlyphContent];

    if (!insertedHasGlyphContent && insertedLength == 1) {
      [self reconcileBlockContinuationAfterNewlineAt:editLocation
                                previousItemWasEmpty:context.preEditParagraphWasEmpty
                                    preEditBlockType:context.preEditBlockType
                                   preEditBlockLevel:context.preEditBlockLevel];
      // Continuation re-seeds fresh block ranges whose ordinal defaults to 1;
      // normalize again so the list-metadata pass renumbers the adjacent run.
      [_blockStore normalizeToLineBoundsInText:[_host plainText]];
    }
  }

  // Determine whether the edit touched a newline (for full-vs-scoped formatting).
  BOOL touchedNewline = context.preEditReplacedNewline;
  if (!touchedNewline && insertedLength > 0) {
    NSString *postEditText = [_host plainText];
    NSUInteger insertedEnd = MIN(editLocation + insertedLength, postEditText.length);
    if (editLocation < insertedEnd) {
      NSRange insertedRun = NSMakeRange(editLocation, insertedEnd - editLocation);
      touchedNewline = [postEditText rangeOfCharacterFromSet:[NSCharacterSet newlineCharacterSet]
                                                     options:0
                                                       range:insertedRun]
                           .location != NSNotFound;
    }
  }

  return touchedNewline;
}

- (NSString *)adjustStoresForEditAtLocation:(NSUInteger)editLocation
                              deletedLength:(NSUInteger)deletedLength
                             insertedLength:(NSUInteger)insertedLength
{
  [_formattingStore adjustForEditAtLocation:editLocation deletedLength:deletedLength insertedLength:insertedLength];
  [_blockStore adjustForEditAtLocation:editLocation deletedLength:deletedLength insertedLength:insertedLength];
  [self pruneOrphanedBlockAnchors];
  NSString *plainText = [_host plainText];
  [_blockStore normalizeToLineBoundsInText:plainText];
  return plainText;
}

- (void)pruneOrphanedBlockAnchors
{
  NSString *text = [_host textStorage].string;
  for (ENRMBlockRange *block in _blockStore.allRanges) {
    if (!ENRMBlockTypePersistsWhenEmpty(block.type)) {
      continue;
    }
    NSUInteger anchor = MIN(block.range.location, text.length);
    BOOL atLineStart = [text paragraphRangeForRange:NSMakeRange(anchor, 0)].location == anchor;
    if (!atLineStart) {
      [_blockStore removeBlockInParagraphRange:NSMakeRange(anchor, 0) inText:text];
    }
  }
}

- (void)detectLinksAtLocation:(NSUInteger)editLocation insertedLength:(NSUInteger)insertedLength
{
  NSString *currentText = [_host plainText];
  NSUInteger clampedEditLocation = MIN(editLocation, currentText.length);
  NSUInteger clampedInsertedLength = MIN(insertedLength, currentText.length - clampedEditLocation);
  [_detectorPipeline processTextChange:currentText
                     modificationRange:NSMakeRange(clampedEditLocation, clampedInsertedLength)];
}

#pragma mark - Pending styles (private)

- (void)applyPendingStylesWithContext:(ENRMEditContext *)context
                            plainText:(NSString *)plainText
                      hasGlyphContent:(BOOL)insertedHasGlyphContent
{
  NSRange insertedRange = NSMakeRange(context.editLocation, context.insertedLength);

  if (insertedHasGlyphContent) {
    for (NSNumber *styleNum in context.pendingStyles) {
      ENRMFormattingRange *newRange = [ENRMFormattingRange rangeWithType:(ENRMInputStyleType)styleNum.integerValue
                                                                   range:insertedRange];
      [_formattingStore addRange:newRange];
    }
  }

  // adjustForEditAtLocation may have expanded an existing range to cover
  // the insertion — carve out the inserted portion for removed styles.
  for (NSNumber *styleNum in context.pendingStyleRemovals) {
    [_formattingStore removeType:(ENRMInputStyleType)styleNum.integerValue inRange:insertedRange];
  }
}

- (BOOL)insertedHasGlyphContentAtLocation:(NSUInteger)location length:(NSUInteger)length text:(NSString *)text
{
  NSUInteger insertedEnd = location + length;
  if (insertedEnd > text.length)
    return NO;
  NSCharacterSet *newlines = [NSCharacterSet newlineCharacterSet];
  for (NSUInteger i = location; i < insertedEnd; i++) {
    if (![newlines characterIsMember:[text characterAtIndex:i]]) {
      return YES;
    }
  }
  return NO;
}

#pragma mark - Block continuation (private)

/// Reconciles blocks after Return: a non-empty item continues as a new item at
/// the same depth, an empty item exits the list (both lines revert to plain
/// paragraphs). Whether a type continues is the handler's continuesOnNewline.
- (void)reconcileBlockContinuationAfterNewlineAt:(NSUInteger)newlineLocation
                            previousItemWasEmpty:(BOOL)previousWasEmpty
                                preEditBlockType:(ENRMInputBlockType)blockType
                               preEditBlockLevel:(NSInteger)blockLevel
{
  id<ENRMBlockHandler> handler = [_formatter handlerForBlockType:blockType];
  if (!handler || ![handler respondsToSelector:@selector(continuesOnNewline)] || !handler.continuesOnNewline) {
    return;
  }

  NSString *text = [_host plainText];
  NSUInteger newLineLocation = newlineLocation + 1;
  if (newLineLocation > text.length) {
    return;
  }
  NSRange originalParagraph = [text paragraphRangeForRange:NSMakeRange(newlineLocation, 0)];
  NSRange newParagraph = [text paragraphRangeForRange:NSMakeRange(newLineLocation, 0)];

  if (previousWasEmpty) {
    // Exit: drop the block from both lines and strip their list paragraph style.
    // Empty lines carry no stamped block-marker attribute for applyFormatting to
    // key off, so the manual strip is the only thing that clears the leftover indent.
    [_blockStore removeBlockInParagraphRange:originalParagraph inText:text];
    [_blockStore removeBlockInParagraphRange:newParagraph inText:text];

    NSTextStorage *storage = [_host textStorage];
    [storage beginEditing];
    NSRange clamped = NSIntersectionRange(originalParagraph, NSMakeRange(0, storage.length));
    if (clamped.length > 0) {
      [storage removeAttribute:NSParagraphStyleAttributeName range:clamped];
    }
    clamped = NSIntersectionRange(newParagraph, NSMakeRange(0, storage.length));
    if (clamped.length > 0) {
      [storage removeAttribute:NSParagraphStyleAttributeName range:clamped];
    }
    [storage endEditing];
    return;
  }

  [_blockStore setBlockType:blockType level:blockLevel forParagraphRange:originalParagraph inText:text];
  [_blockStore setBlockType:blockType level:blockLevel forParagraphRange:newParagraph inText:text];
}

@end
