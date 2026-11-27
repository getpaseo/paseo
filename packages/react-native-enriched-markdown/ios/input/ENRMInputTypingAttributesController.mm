#import "ENRMInputTypingAttributesController.h"
#import "ENRMInputBlockType.h"
#import "InputStylePropsUtils.h"

@implementation ENRMInputTypingAttributesController {
  __weak ENRMPlatformTextView *_textView;
  __weak id<ENRMInputTypingAttributesDataSource> _dataSource;
  ENRMInputFormatterStyle *_formatterStyle;
  ENRMEditSession *_editSession;

  NSMutableSet<NSNumber *> *_pendingStyles;
  NSMutableSet<NSNumber *> *_pendingStyleRemovals;
}

- (instancetype)initWithTextView:(ENRMPlatformTextView *)textView
                  formatterStyle:(ENRMInputFormatterStyle *)style
                      dataSource:(id<ENRMInputTypingAttributesDataSource>)dataSource
                     editSession:(ENRMEditSession *)editSession
{
  self = [super init];
  if (self) {
    _textView = textView;
    _formatterStyle = style;
    _dataSource = dataSource;
    _editSession = editSession;
    _pendingStyles = [NSMutableSet set];
    _pendingStyleRemovals = [NSMutableSet set];
  }
  return self;
}

#pragma mark - Properties

- (NSSet<NSNumber *> *)pendingStyles
{
  return [_pendingStyles copy];
}

- (NSSet<NSNumber *> *)pendingStyleRemovals
{
  return [_pendingStyleRemovals copy];
}

#pragma mark - Style queries

- (BOOL)isEffectiveStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position
{
  BOOL inRange = [_dataSource isStyleActive:type atPosition:position];
  NSNumber *key = @(type);
  if ([_pendingStyleRemovals containsObject:key]) {
    return NO;
  }
  if ([_pendingStyles containsObject:key]) {
    return YES;
  }
  return inRange;
}

#pragma mark - Pending style mutations

- (void)togglePendingStyle:(ENRMInputStyleType)type wasActive:(BOOL)wasActive hasSelection:(BOOL)hasSelection
{
  NSNumber *key = @(type);
  if (hasSelection) {
    [_pendingStyles removeObject:key];
    [_pendingStyleRemovals removeObject:key];
  } else {
    if ([_pendingStyleRemovals containsObject:key]) {
      [_pendingStyleRemovals removeObject:key];
    } else if ([_pendingStyles containsObject:key]) {
      [_pendingStyles removeObject:key];
    } else if (wasActive) {
      [_pendingStyleRemovals addObject:key];
    } else {
      [_pendingStyles addObject:key];
    }
  }
}

- (void)clearPendingStyle:(ENRMInputStyleType)type
{
  NSNumber *key = @(type);
  [_pendingStyles removeObject:key];
  [_pendingStyleRemovals removeObject:key];
}

#pragma mark - Typing attribute synchronization

- (void)syncWithCursorBlock
{
  UIFontDescriptorSymbolicTraits traits = 0;
  if ([_pendingStyles containsObject:@(ENRMInputStyleTypeStrong)]) {
    traits |= UIFontDescriptorTraitBold;
  }
  if ([_pendingStyles containsObject:@(ENRMInputStyleTypeEmphasis)]) {
    traits |= UIFontDescriptorTraitItalic;
  }

  NSInteger headingLevel = [_dataSource headingLevelForCursorParagraph];

  UIFont *font;
  if (headingLevel >= 1 && headingLevel <= 6) {
    UIFont *headingFont = [_formatterStyle headingFontForLevel:headingLevel];
    UIFontDescriptorSymbolicTraits merged = headingFont.fontDescriptor.symbolicTraits | traits;
    UIFontDescriptor *descriptor = [headingFont.fontDescriptor fontDescriptorWithSymbolicTraits:merged];
    font = descriptor ? [UIFont fontWithDescriptor:descriptor size:0] : headingFont;
  } else {
    font = [_formatterStyle fontForTraits:traits];
  }

  NSMutableDictionary *attrs = [_textView.typingAttributes mutableCopy];
  attrs[NSFontAttributeName] = font;
  RCTUIColor *headingColor = headingLevel >= 1 ? [_formatterStyle headingColorForLevel:headingLevel] : nil;
  attrs[NSForegroundColorAttributeName] = headingColor ?: _formatterStyle.baseTextColor;

  ENRMBlockRange *typingListBlock = [_dataSource listBlockForCursorParagraph];
  if (typingListBlock != nil) {
    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    CGFloat indent = (typingListBlock.level + 1) * kENRMListIndentPerDepth;
    paragraph.firstLineHeadIndent = indent;
    paragraph.headIndent = indent;
    paragraph.paragraphSpacingBefore = _formatterStyle.listItemSpacing;
    ENRMApplyLineHeightToParagraphStyle(paragraph, _formatterStyle.baseLineHeight);
    attrs[NSParagraphStyleAttributeName] = paragraph;
  } else {
    [self setNonListParagraphStyleInAttributes:attrs headingLevel:headingLevel];
  }

  if (![attrs isEqualToDictionary:_textView.typingAttributes]) {
    _textView.typingAttributes = attrs;
  }
}

- (void)syncWithPendingStyles
{
  UIFontDescriptorSymbolicTraits traits = 0;
  if ([_pendingStyles containsObject:@(ENRMInputStyleTypeStrong)]) {
    traits |= UIFontDescriptorTraitBold;
  }
  if ([_pendingStyles containsObject:@(ENRMInputStyleTypeEmphasis)]) {
    traits |= UIFontDescriptorTraitItalic;
  }

  NSMutableDictionary *attrs = [_textView.typingAttributes mutableCopy];
  attrs[NSFontAttributeName] = [_formatterStyle fontForTraits:traits];
  _textView.typingAttributes = attrs;
}

- (void)resetForSelectionChange
{
  if (_editSession.isPostEditGracePeriod) {
    return;
  }
  [_pendingStyles removeAllObjects];
  [_pendingStyleRemovals removeAllObjects];
  [self rebuildFromContext];
  if ([_dataSource selectedRange].length == 0) {
    [self syncWithCursorBlock];
  }
}

- (void)clearListParagraphStyle
{
  if (_textView.typingAttributes[NSParagraphStyleAttributeName] == nil) {
    return;
  }
  // Drop the list indent but keep the line height, which also sizes the caret
  // on an empty trailing line and in an empty editor.
  NSMutableDictionary *attrs = [_textView.typingAttributes mutableCopy];
  [self setNonListParagraphStyleInAttributes:attrs headingLevel:[_dataSource headingLevelForCursorParagraph]];
  if (![attrs isEqualToDictionary:_textView.typingAttributes]) {
    _textView.typingAttributes = attrs;
  }
}

#pragma mark - Private

/// Paragraph style for a non-list paragraph: the heading's derived line height,
/// or the base line height, or none when no line height is set.
- (void)setNonListParagraphStyleInAttributes:(NSMutableDictionary *)attrs headingLevel:(NSInteger)headingLevel
{
  CGFloat lineHeight = (headingLevel >= 1 && headingLevel <= 6)
                           ? [_formatterStyle derivedLineHeightForHeadingLevel:headingLevel]
                           : _formatterStyle.baseLineHeight;
  if (lineHeight > 0) {
    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    ENRMApplyLineHeightToParagraphStyle(paragraph, lineHeight);
    attrs[NSParagraphStyleAttributeName] = paragraph;
  } else {
    [attrs removeObjectForKey:NSParagraphStyleAttributeName];
  }
}

- (void)rebuildFromContext
{
  static const ENRMInputStyleType inlineStyles[] = {
      ENRMInputStyleTypeStrong,        ENRMInputStyleTypeEmphasis, ENRMInputStyleTypeUnderline,
      ENRMInputStyleTypeStrikethrough, ENRMInputStyleTypeSpoiler,
  };

  NSRange selection = [_dataSource selectedRange];

  if (selection.length > 0) {
    for (NSUInteger i = 0; i < sizeof(inlineStyles) / sizeof(inlineStyles[0]); i++) {
      ENRMInputStyleType type = inlineStyles[i];
      if ([_dataSource isStyleActive:type atPosition:selection.location]) {
        [_pendingStyles addObject:@(type)];
      }
    }
    return;
  }

  if (selection.location == 0) {
    return;
  }

  for (NSUInteger i = 0; i < sizeof(inlineStyles) / sizeof(inlineStyles[0]); i++) {
    ENRMInputStyleType type = inlineStyles[i];
    if ([_dataSource isStyleAdjacentBefore:type position:selection.location]) {
      [_pendingStyles addObject:@(type)];
    }
  }
}

@end
