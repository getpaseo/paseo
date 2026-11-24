#import "ENRMMarkdownTextView.h"
#import "ENRMLinkPillAttachment.h"
#import "ENRMLinkPillText.h"
#import "ENRMTextHitTest.h"
#import "LinkTapUtils.h"
#import "PasteboardUtils.h"

#if !TARGET_OS_OSX
@interface ENRMMarkdownTextView () <UIContextMenuInteractionDelegate>
@end

@implementation ENRMMarkdownTextView {
  ENRMLinkMenuLift *_pillLift;
  // The pill whose menu is being presented. It draws nothing for as long as its lifted image
  // stands in for it: it would show through that image.
  ENRMLinkPillAttachment *_liftedPill;
  NSUInteger _pillMenuIndex;
}

- (instancetype)initWithFrame:(CGRect)frame textContainer:(NSTextContainer *)textContainer
{
  if (self = [super initWithFrame:frame textContainer:textContainer]) {
    _pillLift = [[ENRMLinkMenuLift alloc] init];
    __weak ENRMMarkdownTextView *weakSelf = self;
    _pillLift.onEnd = ^{ [weakSelf restoreLiftedPill]; };
    [self addInteraction:[[UIContextMenuInteraction alloc] initWithDelegate:self]];
  }
  return self;
}

/// New text moves or replaces the pill under its lifted image.
- (void)setAttributedText:(NSAttributedString *)attributedText
{
  [_pillLift end];
  [super setAttributedText:attributedText];
}

/// The selection with pills expanded, or nil when `range` is not the selection or holds no pill.
/// Only the selection is rewritten: UIKit also reads arbitrary ranges to find word boundaries,
/// and those must keep matching storage offsets.
- (nullable NSAttributedString *)expandedSelectionForRange:(UITextRange *)range
{
  UITextRange *selection = self.selectedTextRange;
  if (!range || !selection || selection.isEmpty || ![range isEqual:selection])
    return nil;
  NSRange selected = self.selectedRange;
  NSTextStorage *storage = self.textStorage;
  if (selected.location == NSNotFound || NSMaxRange(selected) > storage.length)
    return nil;
  NSAttributedString *text = [storage attributedSubstringFromRange:selected];
  NSAttributedString *expanded = ENRMAttributedStringByExpandingLinkPills(text, NULL);
  return expanded == text ? nil : expanded;
}

- (NSString *)textInRange:(UITextRange *)range
{
  return [self expandedSelectionForRange:range].string ?: [super textInRange:range];
}

- (NSAttributedString *)attributedTextInRange:(UITextRange *)range
{
  return [self expandedSelectionForRange:range] ?: [super attributedTextInRange:range];
}

/// The menu's Copy is already replaced by the library's own action; this covers the key command.
- (void)copy:(id)sender
{
  NSRange selected = self.selectedRange;
  if (self.copySelectionHandler && selected.location != NSNotFound && selected.length > 0) {
    self.copySelectionHandler(selected);
    return;
  }
  NSAttributedString *expanded = [self expandedSelectionForRange:self.selectedTextRange];
  if (!expanded) {
    [super copy:sender];
    return;
  }
  copyAttributedStringToPasteboard(expanded, nil, nil);
}

#pragma mark - Pill menus

- (nullable ENRMLinkContextMenus *)linkContextMenus
{
  id delegate = self.delegate;
  return [delegate conformsToProtocol:@protocol(ENRMLinkContextMenuSource)]
             ? [(id<ENRMLinkContextMenuSource>)delegate linkContextMenusForTextView:self]
             : nil;
}

/// Where the pill at `index` is drawn, in the text view's coordinates.
- (CGRect)pillFrameAtIndex:(NSUInteger)index
{
  NSLayoutManager *layoutManager = self.layoutManager;
  NSUInteger glyph = [layoutManager glyphIndexForCharacterAtIndex:index];
  CGSize size = [layoutManager attachmentSizeForGlyphAtIndex:glyph];
  if (size.width <= 0 || size.height <= 0)
    return CGRectNull;
  CGRect line = [layoutManager lineFragmentRectForGlyphAtIndex:glyph effectiveRange:NULL];
  // TextKit places an attachment glyph at the bottom edge of its bounds.
  CGPoint location = [layoutManager locationForGlyphAtIndex:glyph];
  UIEdgeInsets inset = self.textContainerInset;
  return CGRectMake(inset.left + line.origin.x + location.x, inset.top + line.origin.y + location.y - size.height,
                    size.width, size.height);
}

/// Whether the character at `index` is a pill whose link has a menu.
- (BOOL)presentsLinkMenuAtIndex:(NSUInteger)index
{
  ENRMLinkContextMenus *menus = [self linkContextMenus];
  NSTextStorage *storage = self.textStorage;
  if (menus.entries.count == 0 || index >= storage.length)
    return NO;
  id attachment = [storage attribute:NSAttachmentAttributeName atIndex:index effectiveRange:NULL];
  return [attachment isKindOfClass:ENRMLinkPillAttachment.class] &&
         [menus hasMenuForURL:linkURLAtRange(self, NSMakeRange(index, 1))];
}

/// The character index of the pill under `point` when its link has a menu, else NSNotFound.
- (NSUInteger)menuPillIndexAtPoint:(CGPoint)point
{
  if ([self linkContextMenus].entries.count == 0)
    return NSNotFound;
  NSUInteger index = ENRMCharacterIndexAtPoint(self, point);
  if (index == NSNotFound || ![self presentsLinkMenuAtIndex:index] ||
      !CGRectContainsPoint([self pillFrameAtIndex:index], point))
    return NSNotFound;
  return index;
}

- (void)setPill:(ENRMLinkPillAttachment *)pill lifted:(BOOL)lifted
{
  pill.lifted = lifted;
  NSTextStorage *storage = self.textStorage;
  [storage enumerateAttribute:NSAttachmentAttributeName
                      inRange:NSMakeRange(0, storage.length)
                      options:0
                   usingBlock:^(id value, NSRange range, BOOL *stop) {
                     if (value != pill)
                       return;
                     [self.layoutManager invalidateDisplayForCharacterRange:range];
                     *stop = YES;
                   }];
}

- (void)restoreLiftedPill
{
  if (_liftedPill)
    [self setPill:_liftedPill lifted:NO];
  _liftedPill = nil;
}

- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                        configurationForMenuAtLocation:(CGPoint)location
{
  [_pillLift end];
  _pillMenuIndex = [self menuPillIndexAtPoint:location];
  if (_pillMenuIndex == NSNotFound)
    return nil;
  UIMenu *menu = [[self linkContextMenus] menuForURL:linkURLAtRange(self, NSMakeRange(_pillMenuIndex, 1))
                                               title:linkTitleAtIndex(self.textStorage, _pillMenuIndex)];
  if (!menu)
    return nil;
  return [UIContextMenuConfiguration
      configurationWithIdentifier:nil
                  previewProvider:nil
                   actionProvider:^UIMenu *(NSArray<UIMenuElement *> *suggestedActions) { return menu; }];
}

/// The pill is lifted as an image of itself, see `ENRMLinkMenuLift`.
- (UITargetedPreview *)pillMenuPreview
{
  if (![_pillLift isOverView:self]) {
    NSTextStorage *storage = self.textStorage;
    if (self.window == nil || _pillMenuIndex >= storage.length)
      return nil;
    id attachment = [storage attribute:NSAttachmentAttributeName atIndex:_pillMenuIndex effectiveRange:NULL];
    CGRect frame = [self pillFrameAtIndex:_pillMenuIndex];
    if (![attachment isKindOfClass:ENRMLinkPillAttachment.class] || CGRectIsNull(frame))
      return nil;
    UIImage *image = [(ENRMLinkPillAttachment *)attachment imageForBounds:(CGRect){CGPointZero, frame.size}
                                                            textContainer:self.textContainer
                                                           characterIndex:_pillMenuIndex];
    [_pillLift layImage:image atFrame:frame overView:self];
    _liftedPill = attachment;
    [self setPill:_liftedPill lifted:YES];
  }
  return [_pillLift previewWithCornerRadius:_liftedPill.cornerRadius backgroundColor:UIColor.clearColor];
}

- (UITargetedPreview *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
    previewForHighlightingMenuWithConfiguration:(UIContextMenuConfiguration *)configuration
{
  return [self pillMenuPreview];
}

- (UITargetedPreview *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
    previewForDismissingMenuWithConfiguration:(UIContextMenuConfiguration *)configuration
{
  return [self pillMenuPreview];
}

- (void)contextMenuInteraction:(UIContextMenuInteraction *)interaction
       willEndForConfiguration:(UIContextMenuConfiguration *)configuration
                      animator:(id<UIContextMenuInteractionAnimating>)animator
{
  [_pillLift endWithAnimator:animator];
}

@end
#endif
