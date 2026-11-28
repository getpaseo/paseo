#import "ENRMInputFormatter.h"
#import "ENRMBlockHandler.h"
#import "ENRMBoldStyleHandler.h"
#import "ENRMHeadingBlockHandler.h"
#import "ENRMInputBlockType.h"
#import "ENRMItalicStyleHandler.h"
#import "ENRMLinkStyleHandler.h"
#import "ENRMOrderedListBlockHandler.h"
#import "ENRMSpoilerStyleHandler.h"
#import "ENRMStrikethroughStyleHandler.h"
#import "ENRMStyleHandler.h"
#import "ENRMUnderlineStyleHandler.h"
#import "ENRMUnorderedListBlockHandler.h"
#import "ParagraphStyleUtils.h"

/// Sets `key` to `value` only on sub-runs whose value differs, recording each
/// written range in `changed` so the caller can invalidate just what changed.
static void ENRMSetAttributeIfChanged(NSMutableAttributedString *storage, NSAttributedStringKey key, id value,
                                      NSRange range, NSMutableIndexSet *changed)
{
  if (range.length == 0) {
    return;
  }
  NSMutableArray<NSValue *> *rangesToSet = [NSMutableArray array];
  [storage enumerateAttribute:key
                      inRange:range
                      options:0
                   usingBlock:^(id current, NSRange subRange, BOOL *stop) {
                     BOOL equal = (current == value) || (current != nil && [current isEqual:value]);
                     if (!equal) {
                       [rangesToSet addObject:[NSValue valueWithRange:subRange]];
                     }
                   }];
  for (NSValue *rangeValue in rangesToSet) {
    NSRange subRange = rangeValue.rangeValue;
    [storage addAttribute:key value:value range:subRange];
    [changed addIndexesInRange:subRange];
  }
}

/// Removes `key` only where present, recording cleared ranges in `changed`.
static void ENRMRemoveAttributeIfPresent(NSMutableAttributedString *storage, NSAttributedStringKey key, NSRange range,
                                         NSMutableIndexSet *changed)
{
  if (range.length == 0) {
    return;
  }
  NSMutableArray<NSValue *> *rangesToClear = [NSMutableArray array];
  [storage enumerateAttribute:key
                      inRange:range
                      options:0
                   usingBlock:^(id current, NSRange subRange, BOOL *stop) {
                     if (current != nil) {
                       [rangesToClear addObject:[NSValue valueWithRange:subRange]];
                     }
                   }];
  for (NSValue *rangeValue in rangesToClear) {
    NSRange subRange = rangeValue.rangeValue;
    [storage removeAttribute:key range:subRange];
    [changed addIndexesInRange:subRange];
  }
}

@implementation ENRMInputFormatter {
  NSDictionary<NSNumber *, id<ENRMStyleHandler>> *_styleHandlers;
  NSDictionary<NSNumber *, id<ENRMBlockHandler>> *_blockHandlers;
}

- (instancetype)init
{
  if (self = [super init]) {
    NSArray<id<ENRMStyleHandler>> *handlers = @[
      [[ENRMBoldStyleHandler alloc] init],
      [[ENRMItalicStyleHandler alloc] init],
      [[ENRMUnderlineStyleHandler alloc] init],
      [[ENRMStrikethroughStyleHandler alloc] init],
      [[ENRMLinkStyleHandler alloc] init],
      [[ENRMSpoilerStyleHandler alloc] init],
    ];
    NSMutableDictionary<NSNumber *, id<ENRMStyleHandler>> *map = [NSMutableDictionary dictionary];
    for (id<ENRMStyleHandler> handler in handlers) {
      map[@(handler.styleType)] = handler;
    }
    _styleHandlers = [map copy];

    ENRMHeadingBlockHandler *headingHandler = [[ENRMHeadingBlockHandler alloc] init];
    NSMutableDictionary<NSNumber *, id<ENRMBlockHandler>> *blockMap = [NSMutableDictionary dictionary];
    for (NSInteger level = 1; level <= 6; level++) {
      blockMap[@(ENRMBlockTypeForHeadingLevel(level))] = headingHandler;
    }
    blockMap[@(ENRMInputBlockTypeUnorderedListItem)] = [[ENRMUnorderedListBlockHandler alloc] init];
    blockMap[@(ENRMInputBlockTypeOrderedListItem)] = [[ENRMOrderedListBlockHandler alloc] init];
    _blockHandlers = [blockMap copy];
  }
  return self;
}

- (nullable id<ENRMStyleHandler>)handlerForStyleType:(ENRMInputStyleType)type
{
  return _styleHandlers[@(type)];
}

- (nullable id<ENRMBlockHandler>)handlerForBlockType:(ENRMInputBlockType)type
{
  return _blockHandlers[@(type)];
}

- (void)applyFormattingRanges:(NSArray<ENRMFormattingRange *> *)ranges
                   toTextView:(ENRMPlatformTextView *)textView
                        style:(ENRMInputFormatterStyle *)style
{
  [self applyFormattingRanges:ranges
                   toTextView:textView
                        style:style
                scopedToRange:NSMakeRange(0, textView.textStorage.length)];
}

- (void)applyFormattingRanges:(NSArray<ENRMFormattingRange *> *)ranges
                   toTextView:(ENRMPlatformTextView *)textView
                        style:(ENRMInputFormatterStyle *)style
                scopedToRange:(NSRange)scope
{
  NSTextStorage *textStorage = textView.textStorage;
  NSUInteger textLength = textStorage.length;

  if (textLength == 0) {
    return;
  }

  NSUInteger scopeStart = MIN(scope.location, textLength);
  NSUInteger scopeEnd = MIN(NSMaxRange(scope), textLength);
  if (scopeEnd <= scopeStart) {
    return;
  }
  NSRange scopeRange = NSMakeRange(scopeStart, scopeEnd - scopeStart);
  NSUInteger scopeLength = scopeRange.length;

  // Diff every write and invalidate only what changed, so unchanged content in
  // scope (e.g. a table below a plain-paragraph edit) is not re-laid out (#739).
  NSMutableIndexSet *changed = [NSMutableIndexSet indexSet];

  [textStorage beginEditing];

  // Reset to base; fonts are resolved per trait run below.
  ENRMSetAttributeIfChanged(textStorage, NSForegroundColorAttributeName, style.baseTextColor, scopeRange, changed);
  ENRMRemoveAttributeIfPresent(textStorage, NSUnderlineStyleAttributeName, scopeRange, changed);
  ENRMRemoveAttributeIfPresent(textStorage, NSStrikethroughStyleAttributeName, scopeRange, changed);
  ENRMRemoveAttributeIfPresent(textStorage, NSBackgroundColorAttributeName, scopeRange, changed);

  UIFontDescriptorSymbolicTraits *traitMap =
      (UIFontDescriptorSymbolicTraits *)calloc(scopeLength, sizeof(UIFontDescriptorSymbolicTraits));
  if (!traitMap) {
    [textStorage endEditing];
    return;
  }

  for (ENRMFormattingRange *formattingRange in ranges) {
    if (formattingRange.range.length == 0 || NSMaxRange(formattingRange.range) > textLength) {
      continue;
    }

    // Ranges straddling the scope boundary are clipped: attributes are
    // per-character and the out-of-scope part is untouched by the reset above.
    NSRange clipped = NSIntersectionRange(formattingRange.range, scopeRange);
    if (clipped.length == 0) {
      continue;
    }

    id<ENRMStyleHandler> handler = _styleHandlers[@(formattingRange.type)];
    if (!handler) {
      continue;
    }

    UIFontDescriptorSymbolicTraits traits = [handler fontTraits];
    if (traits != 0) {
      NSUInteger start = clipped.location;
      NSUInteger end = NSMaxRange(clipped);
      for (NSUInteger i = start; i < end; i++) {
        traitMap[i - scopeStart] |= traits;
      }
    }

    // Handler writes are not diffed; mark the styled run changed to keep its invalidation.
    [handler applyNonFontAttributesToTextStorage:textStorage range:clipped formattingRange:formattingRange style:style];
    [changed addIndexesInRange:clipped];
  }

  // Resolve the final font per trait run (base or styled), diffed.
  NSUInteger runStart = 0;
  UIFontDescriptorSymbolicTraits currentTraits = traitMap[0];

  for (NSUInteger i = 1; i <= scopeLength; i++) {
    UIFontDescriptorSymbolicTraits nextTraits = (i < scopeLength) ? traitMap[i] : ~currentTraits;
    if (nextTraits != currentTraits) {
      UIFont *font = (currentTraits != 0) ? [style fontForTraits:currentTraits] : style.baseFont;
      ENRMSetAttributeIfChanged(textStorage, NSFontAttributeName, font,
                                NSMakeRange(scopeStart + runStart, i - runStart), changed);
      runStart = i;
      currentTraits = (i < scopeLength) ? traitMap[i] : 0;
    }
  }

  free(traitMap);

  [self applyBaseLineHeight:style.baseLineHeight toNonHeadingParagraphsInTextStorage:textStorage range:scopeRange];

  [textStorage endEditing];

  NSLayoutManager *layoutManager = textStorage.layoutManagers.firstObject;
  if (layoutManager) {
    // Invalidate only changed ranges; ensureLayout over the scope only realizes
    // already-dirty runs, so the inserted line still lays out.
    [changed enumerateRangesUsingBlock:^(NSRange changedRange, BOOL *stop) {
      [layoutManager invalidateLayoutForCharacterRange:changedRange actualCharacterRange:NULL];
    }];
    [layoutManager ensureLayoutForCharacterRange:scopeRange];
  }

  ENRMSetNeedsDisplay(textView);
}

- (void)applyBlockRanges:(NSArray<ENRMBlockRange *> *)blockRanges
              toTextView:(ENRMPlatformTextView *)textView
                   style:(ENRMInputFormatterStyle *)style
{
  [self applyBlockRanges:blockRanges
              toTextView:textView
                   style:style
           scopedToRange:NSMakeRange(0, textView.textStorage.length)];
}

- (void)applyBlockRanges:(NSArray<ENRMBlockRange *> *)blockRanges
              toTextView:(ENRMPlatformTextView *)textView
                   style:(ENRMInputFormatterStyle *)style
           scopedToRange:(NSRange)scope
{
  if (_blockHandlers.count == 0) {
    return;
  }

  NSTextStorage *textStorage = textView.textStorage;
  NSUInteger textLength = textStorage.length;
  if (textLength == 0) {
    return;
  }

  NSUInteger scopeStart = MIN(scope.location, textLength);
  NSUInteger scopeEnd = MIN(NSMaxRange(scope), textLength);
  if (scopeEnd <= scopeStart) {
    return;
  }
  NSRange scopeRange = NSMakeRange(scopeStart, scopeEnd - scopeStart);

  [textStorage beginEditing];

  // Reset pass: strip everything the previous block pass applied — paragraphs
  // are found via the ENRMBlockTypeAttributeName marker — so a removed or moved
  // block doesn't leave stale paragraph styling behind. Character-level
  // attributes (fonts, colors) are already reset by the inline pass, which runs
  // first. This runs even with zero current ranges: deleting the last block
  // must still clear its styling.
  NSMutableArray<NSValue *> *previouslyClaimedRanges = [NSMutableArray array];
  [textStorage enumerateAttribute:ENRMBlockTypeAttributeName
                          inRange:scopeRange
                          options:0
                       usingBlock:^(id value, NSRange range, BOOL *stop) {
                         if (value != nil) {
                           [previouslyClaimedRanges addObject:[NSValue valueWithRange:range]];
                         }
                       }];
  for (NSValue *rangeValue in previouslyClaimedRanges) {
    NSRange range = rangeValue.rangeValue;
    [textStorage removeAttribute:ENRMBlockTypeAttributeName range:range];
    [textStorage removeAttribute:ENRMBlockLevelAttributeName range:range];
    [textStorage removeAttribute:ENRMBlockOrdinalAttributeName range:range];
    [textStorage removeAttribute:NSParagraphStyleAttributeName range:range];
    [textStorage removeAttribute:NSBaselineOffsetAttributeName range:range];
  }

  for (ENRMBlockRange *blockRange in blockRanges) {
    BOOL isHeadingAnchor = blockRange.range.length == 0 && ENRMHeadingLevelForBlockType(blockRange.type) > 0;

    if (!isHeadingAnchor && (blockRange.range.length == 0 || NSMaxRange(blockRange.range) > textLength)) {
      continue;
    }
    if (isHeadingAnchor && blockRange.range.location > textLength) {
      continue;
    }

    // Scope check: normal blocks are line-scoped and either fully inside or
    // outside; a zero-length heading anchor is in-scope when its point falls
    // within [scopeStart, scopeEnd] inclusive.
    if (isHeadingAnchor) {
      if (blockRange.range.location < scopeRange.location || blockRange.range.location > NSMaxRange(scopeRange)) {
        continue;
      }
    } else if (NSIntersectionRange(blockRange.range, scopeRange).length == 0) {
      continue;
    }

    id<ENRMBlockHandler> handler = _blockHandlers[@(blockRange.type)];
    if (!handler) {
      continue;
    }

    NSUInteger attrIndex = blockRange.range.location;
    if (attrIndex >= textLength) {
      attrIndex = textLength > 0 ? textLength - 1 : 0;
    }

    NSParagraphStyle *existingStyle = [textStorage attribute:NSParagraphStyleAttributeName
                                                     atIndex:attrIndex
                                              effectiveRange:NULL];
    NSMutableParagraphStyle *paragraphStyle =
        existingStyle ? [existingStyle mutableCopy] : [[NSMutableParagraphStyle alloc] init];
    NSMutableDictionary<NSAttributedStringKey, id> *attributes = [NSMutableDictionary dictionary];

    [handler applyAttributesToParagraphStyle:paragraphStyle attributes:attributes blockRange:blockRange style:style];

    attributes[NSParagraphStyleAttributeName] = paragraphStyle;
    attributes[ENRMBlockTypeAttributeName] = @(blockRange.type);
    attributes[ENRMBlockLevelAttributeName] = @(blockRange.level);
    attributes[ENRMBlockOrdinalAttributeName] = @(blockRange.ordinal);

    // For a zero-length heading anchor on an empty line, stamp onto the line
    // terminator so the paragraph style (heading font size) takes effect.
    NSRange applyRange = blockRange.range;
    if (isHeadingAnchor && applyRange.location < textLength) {
      applyRange = NSMakeRange(applyRange.location, 1);
    }

    UIFont *blockFont = attributes[NSFontAttributeName];
    if (blockFont) {
      [attributes removeObjectForKey:NSFontAttributeName];
      if (applyRange.length > 0) {
        [self mergeFontSize:blockFont overRange:applyRange inTextStorage:textStorage];
      }
    }

    if (applyRange.length > 0) {
      [textStorage addAttributes:attributes range:applyRange];
      if (paragraphStyle.minimumLineHeight > 0) {
        applyBaselineOffset(textStorage, applyRange);
      }
    }
  }

  // Default body line height on lists and plain paragraphs after block styles
  // (indent, heading override) are reconciled.
  [self applyBaseLineHeight:style.baseLineHeight toNonHeadingParagraphsInTextStorage:textStorage range:scopeRange];

  [textStorage endEditing];

  ENRMSetNeedsDisplay(textView);
}

/// Body line height on every paragraph that is not a heading. Lists share this
/// default so toggling a list cannot drop line height. Headings keep the
/// derived height from the heading handler. When lineHeight is <= 0, clears a
/// previously applied body line height. Writes only what differs, so unchanged
/// paragraphs are not re-laid out.
- (void)applyBaseLineHeight:(CGFloat)lineHeight
    toNonHeadingParagraphsInTextStorage:(NSTextStorage *)textStorage
                                  range:(NSRange)scopeRange
{
  if (scopeRange.length == 0) {
    return;
  }

  NSString *string = textStorage.string;
  NSUInteger position = scopeRange.location;
  NSUInteger scopeEnd = NSMaxRange(scopeRange);
  while (position < scopeEnd) {
    NSRange paragraphRange = [string paragraphRangeForRange:NSMakeRange(position, 0)];
    paragraphRange = NSIntersectionRange(paragraphRange, scopeRange);
    if (paragraphRange.length == 0) {
      break;
    }

    id blockType = [textStorage attribute:ENRMBlockTypeAttributeName
                                  atIndex:paragraphRange.location
                           effectiveRange:NULL];
    NSInteger headingLevel = 0;
    if ([blockType isKindOfClass:[NSNumber class]]) {
      headingLevel = ENRMHeadingLevelForBlockType((ENRMInputBlockType)[blockType integerValue]);
    }
    if (headingLevel == 0) {
      // Unlike applyLineHeight, overwrite the line height left by an earlier
      // pass, or clear it when lineHeight is <= 0. Leave paragraphs that never
      // had a line height without a paragraph style.
      NSMutableParagraphStyle *paragraphStyle = getOrCreateParagraphStyle(textStorage, paragraphRange.location);
      if (lineHeight > 0 || paragraphStyle.minimumLineHeight > 0) {
        paragraphStyle.minimumLineHeight = 0;
        paragraphStyle.maximumLineHeight = 0;
        ENRMApplyLineHeightToParagraphStyle(paragraphStyle, lineHeight);
        ENRMSetAttributeIfChanged(textStorage, NSParagraphStyleAttributeName, paragraphStyle, paragraphRange, nil);
      }

      // Unlike applyBaselineOffset, overwrite an offset centered for a previous
      // line height or font, and clear it when none is needed. Unlike the text renderer,
      // the input has no block images or super/subscript offsets to preserve.
      CGFloat baselineOffset = calculateBaselineOffset(textStorage, paragraphRange);
      if (baselineOffset > 0) {
        ENRMSetAttributeIfChanged(textStorage, NSBaselineOffsetAttributeName, @(baselineOffset), paragraphRange, nil);
      } else {
        ENRMRemoveAttributeIfPresent(textStorage, NSBaselineOffsetAttributeName, paragraphRange, nil);
      }
    }

    NSUInteger nextPosition = NSMaxRange(paragraphRange);
    if (nextPosition <= position) {
      break;
    }
    position = nextPosition;
  }
}

/// Applies `blockFont` over `range` while preserving the symbolic traits already
/// present on each existing font run (set by the inline formatting pass). The
/// resulting font takes its size and descriptor from `blockFont` but unions in
/// the run's traits, so inline bold/italic survives the block's size change.
- (void)mergeFontSize:(UIFont *)blockFont overRange:(NSRange)range inTextStorage:(NSTextStorage *)textStorage
{
  UIFontDescriptorSymbolicTraits blockTraits = blockFont.fontDescriptor.symbolicTraits;

  [textStorage enumerateAttribute:NSFontAttributeName
                          inRange:range
                          options:0
                       usingBlock:^(UIFont *_Nullable runFont, NSRange runRange, BOOL *_Nonnull stop) {
                         UIFontDescriptorSymbolicTraits runTraits = runFont ? runFont.fontDescriptor.symbolicTraits : 0;
                         UIFontDescriptorSymbolicTraits mergedTraits = blockTraits | runTraits;

                         UIFont *resolved = blockFont;
                         if (mergedTraits != blockTraits) {
                           UIFontDescriptor *descriptor =
                               [blockFont.fontDescriptor fontDescriptorWithSymbolicTraits:mergedTraits];
                           if (descriptor) {
                             resolved = [UIFont fontWithDescriptor:descriptor size:0];
                           }
                         }
                         [textStorage addAttribute:NSFontAttributeName value:resolved range:runRange];
                       }];
}

@end
