#import "ENRMInputTextView.h"
#import "ENRMInputLayoutManager.h"
#import "EnrichedMarkdownTextInput+Internal.h"
#import "EnrichedMarkdownTextInput.h"
#import "PasteboardUtils.h"
#if TARGET_OS_OSX
#import <objc/message.h>
#endif

NSString *const kENRMMarkdownPasteboardType = @"com.swmansion.enriched-markdown.markdown";

#if !TARGET_OS_OSX

@implementation ENRMInputTextView {
  CGFloat _lastLayoutWidth;
}

- (void)copy:(id)sender
{
  NSRange selection = self.selectedRange;
  if (selection.length == 0) {
    return;
  }

  NSString *plainText = [self.text substringWithRange:selection];
  NSString *markdown = [self.markdownTextInput markdownForSelectedRange];
  NSMutableDictionary *items = [NSMutableDictionary dictionary];
  items[kUTIPlainText] = plainText;
  if (markdown.length > 0) {
    items[kENRMMarkdownPasteboardType] = markdown;
  }
  copyItemsToPasteboard(items);
}

- (void)cut:(id)sender
{
  [self copy:sender];
  [self.markdownTextInput replaceSelectedTextWith:@"" formattingRanges:@[]];
}

- (void)paste:(id)sender
{
  UIPasteboard *pasteboard = [UIPasteboard generalPasteboard];

  NSString *markdown = nil;
  id markdownValue = [pasteboard valueForPasteboardType:kENRMMarkdownPasteboardType];
  if ([markdownValue isKindOfClass:[NSString class]]) {
    markdown = markdownValue;
  } else if ([markdownValue isKindOfClass:[NSData class]]) {
    markdown = [[NSString alloc] initWithData:markdownValue encoding:NSUTF8StringEncoding];
  }

  if (markdown.length > 0 && self.markdownTextInput != nil) {
    [self.markdownTextInput pasteMarkdown:markdown];
    return;
  }

  // External plain text is treated as markdown so pasted syntax ("- ", "#",
  // "**") formats instead of landing literal; syntax-free text is unchanged.
  NSString *plainText = pasteboard.string;
  if (plainText.length > 0 && self.markdownTextInput != nil) {
    [self.markdownTextInput pasteMarkdown:plainText];
  } else if (plainText.length > 0) {
    [self replaceRange:self.selectedTextRange withText:plainText];
  }
}

- (BOOL)canPerformAction:(SEL)action withSender:(id)sender
{
  if (action == @selector(paste:)) {
    UIPasteboard *pasteboard = [UIPasteboard generalPasteboard];
    if (pasteboard.hasStrings || [pasteboard containsPasteboardTypes:@[ kENRMMarkdownPasteboardType ]]) {
      return YES;
    }
  }
  return [super canPerformAction:action withSender:sender];
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  CGFloat currentWidth = self.bounds.size.width;
  if (self.markdownTextInput != nil && fabs(currentWidth - _lastLayoutWidth) > 0.5) {
    _lastLayoutWidth = currentWidth;
    [self.markdownTextInput scheduleRelayoutIfNeeded];
  }
}

- (void)deleteBackward
{
  // Backspace at the very start of the document doesn't fire the text-change
  // delegate (nothing precedes the caret), so removing/outdenting the first
  // line's list marker has to be handled here.
  if (self.markdownTextInput != nil && [self.markdownTextInput handleBackspaceAtDocumentStart]) {
    return;
  }
  [super deleteBackward];
}

/// Hardware-keyboard Tab / Shift+Tab indent and outdent the current list item.
/// UIKeyCommand only fires for an attached keyboard; on-screen Tab/Backspace go
/// through the text-change delegate (see handleListKeyForReplacementRange:).
- (NSArray<UIKeyCommand *> *)keyCommands
{
  return @[
    [UIKeyCommand keyCommandWithInput:@"\t" modifierFlags:0 action:@selector(enrmIndentList:)],
    [UIKeyCommand keyCommandWithInput:@"\t" modifierFlags:UIKeyModifierShift action:@selector(enrmOutdentList:)],
  ];
}

- (void)enrmIndentList:(UIKeyCommand *)command
{
  [self.markdownTextInput indentList];
}

- (void)enrmOutdentList:(UIKeyCommand *)command
{
  [self.markdownTextInput outdentList];
}

- (void)drawRect:(CGRect)rect
{
  [super drawRect:rect];
  // A wholly empty editor has no glyphs, so the layout manager's
  // drawGlyphsForGlyphRange: never runs — draw decorations here instead.
  if (self.text.length == 0) {
    NSLayoutManager *layoutManager = self.layoutManager;
    if ([layoutManager isKindOfClass:[ENRMInputLayoutManager class]]) {
      [(ENRMInputLayoutManager *)layoutManager drawEmptyEditorDecorationsWithInset:self.textContainerInset];
    }
  }
}

@end

#else // TARGET_OS_OSX

@implementation ENRMInputTextView {
  CGFloat _lastLayoutWidth;
}

- (void)copy:(id)sender
{
  NSRange selection = self.selectedRange;
  if (selection.length == 0) {
    return;
  }

  NSString *plainText = [self.string substringWithRange:selection];
  NSString *markdown = [self.markdownTextInput markdownForSelectedRange];
  NSMutableDictionary *items = [NSMutableDictionary dictionary];
  items[kUTIPlainText] = plainText;
  if (markdown.length > 0) {
    items[kENRMMarkdownPasteboardType] = markdown;
  }
  copyItemsToPasteboard(items);
}

- (void)cut:(id)sender
{
  [self copy:sender];
  [self.markdownTextInput replaceSelectedTextWith:@"" formattingRanges:@[]];
}

- (void)paste:(id)sender
{
  NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];

  NSString *markdown = [pasteboard stringForType:kENRMMarkdownPasteboardType];
  if (markdown.length > 0 && self.markdownTextInput != nil) {
    [self.markdownTextInput pasteMarkdown:markdown];
    return;
  }

  // External plain text is treated as markdown so pasted syntax ("- ", "#",
  // "**") formats instead of landing literal; syntax-free text is unchanged.
  NSString *plainText = [pasteboard stringForType:NSPasteboardTypeString];
  if (plainText.length > 0 && self.markdownTextInput != nil) {
    [self.markdownTextInput pasteMarkdown:plainText];
  } else if (plainText.length > 0) {
    [self insertText:plainText replacementRange:self.selectedRange];
  }
}

- (BOOL)validateMenuItem:(NSMenuItem *)menuItem
{
  if (menuItem.action == @selector(paste:)) {
    NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
    return ([pasteboard stringForType:NSPasteboardTypeString] != nil ||
            [pasteboard stringForType:kENRMMarkdownPasteboardType] != nil);
  }
  return [super validateMenuItem:menuItem];
}

- (BOOL)acceptsFirstResponder
{
  return self.isEditable;
}

- (void)mouseDown:(NSEvent *)event
{
  if (self.window != nil) {
    [self.window makeFirstResponder:self];
  }
  [super mouseDown:event];
}

- (NSMenu *)menuForEvent:(NSEvent *)event
{
  NSMenu *menu = [super menuForEvent:event];
  if (self.markdownTextInput != nil) {
    return [self.markdownTextInput enrichedMenuForEvent:event defaultMenu:menu textView:self];
  }
  return menu;
}

- (void)setTypingAttributes:(NSDictionary *)typingAttributes
{
  // RCTUITextView's override discards the value and always resets to
  // defaultTextAttributes.  We need the actual value (e.g. list paragraph
  // indent) to reach NSTextView so the caret positions correctly.
  struct objc_super superSuper = {self, [NSTextView class]};
  ((void (*)(struct objc_super *, SEL, NSDictionary *))objc_msgSendSuper)(&superSuper, _cmd, typingAttributes);
}

- (void)layout
{
  [super layout];
  CGFloat currentWidth = self.bounds.size.width;
  if (self.markdownTextInput != nil && fabs(currentWidth - _lastLayoutWidth) > 0.5) {
    _lastLayoutWidth = currentWidth;
    [self.markdownTextInput scheduleRelayoutIfNeeded];
  }
}

- (void)drawRect:(NSRect)rect
{
  [super drawRect:rect];
  if (self.string.length == 0) {
    NSLayoutManager *lm = self.layoutManager;
    if ([lm isKindOfClass:[ENRMInputLayoutManager class]]) {
      NSEdgeInsets insets = self.textContainerInsets;
      insets.left += self.textContainer.lineFragmentPadding;
      [(ENRMInputLayoutManager *)lm drawEmptyEditorDecorationsWithInset:insets];
    }
  }
}

@end

#endif
