#import "ContextMenuUtils.h"
#import "ENRMUIKit.h"
#import "EnrichedMarkdownTextInput+Internal.h"
#import "PasteboardUtils.h"

@implementation EnrichedMarkdownTextInput (ContextMenu)

- (void)copySelectedRangeAsMarkdown
{
  NSString *markdown = [self markdownForSelectedRange];
  if (markdown) {
    copyStringToPasteboard(markdown);
  }
}

// TODO: Remove API_AVAILABLE(ios(16.0)) guard when the minimum iOS deployment target in RN is bumped to 16.
#if !TARGET_OS_OSX
- (UIMenu *)textView:(UITextView *)textView
    editMenuForTextInRange:(NSRange)range
          suggestedActions:(NSArray<UIMenuElement *> *)suggestedActions API_AVAILABLE(ios(16.0))
{
  if (range.length == 0) {
    return nil;
  }

  ENRMInputSelectionMenuConfig menuConfig = [self inputSelectionMenuConfig];
  ENRMFormatMenuConfig fmtConfig = [self formatMenuConfig];
  __weak EnrichedMarkdownTextInput *weakSelf = self;

  const struct {
    NSString *title;
    NSString *icon;
    ENRMInputStyleType styleType;
    BOOL visible;
  } formatItems[] = {
      {fmtConfig.boldLabel, @"bold", ENRMInputStyleTypeStrong, fmtConfig.bold},
      {fmtConfig.italicLabel, @"italic", ENRMInputStyleTypeEmphasis, fmtConfig.italic},
      {fmtConfig.underlineLabel, @"underline", ENRMInputStyleTypeUnderline, fmtConfig.underline},
      {fmtConfig.strikethroughLabel, @"strikethrough", ENRMInputStyleTypeStrikethrough, fmtConfig.strikethrough},
      {fmtConfig.spoilerLabel, @"eye.slash", ENRMInputStyleTypeSpoiler, fmtConfig.spoiler},
      {fmtConfig.linkLabel, @"link", ENRMInputStyleTypeLink, fmtConfig.link},
  };
  const NSUInteger formatItemCount = sizeof(formatItems) / sizeof(formatItems[0]);

  NSMutableArray<UIAction *> *formatActions = [NSMutableArray arrayWithCapacity:formatItemCount];
  for (NSUInteger i = 0; i < formatItemCount; i++) {
    if (!formatItems[i].visible) {
      continue;
    }
    ENRMInputStyleType styleType = formatItems[i].styleType;
    UIAction *action = [UIAction actionWithTitle:formatItems[i].title
                                           image:[UIImage systemImageNamed:formatItems[i].icon]
                                      identifier:nil
                                         handler:^(__kindof UIAction *_) {
                                           if (styleType == ENRMInputStyleTypeLink) {
                                             [weakSelf showLinkPrompt];
                                           } else {
                                             [weakSelf toggleInlineStyle:styleType];
                                           }
                                         }];
    [formatActions addObject:action];
  }
  UIMenu *formatMenu = [UIMenu menuWithTitle:menuConfig.formatLabel
                                       image:[UIImage systemImageNamed:@"textformat"]
                                  identifier:@"com.enrichedmarkdown.format"
                                     options:0
                                    children:formatActions];

  UIAction *copyMarkdownAction =
      [UIAction actionWithTitle:menuConfig.copyAsMarkdownLabel
                          image:[UIImage systemImageNamed:@"doc.text"]
                     identifier:@"com.enrichedmarkdown.copyMarkdown"
                        handler:^(__kindof UIAction *action) { [self copySelectedRangeAsMarkdown]; }];

  NSArray<NSString *> *customItemTexts = [self contextMenuItemTexts];
  NSArray<NSString *> *customItemIcons = [self contextMenuItemIcons];
  NSMutableArray<UIMenuElement *> *allActions = [NSMutableArray arrayWithCapacity:customItemTexts.count];
  [customItemTexts enumerateObjectsUsingBlock:^(NSString *itemText, NSUInteger index, BOOL *_) {
    NSString *iconName = index < customItemIcons.count ? customItemIcons[index] : nil;
    UIImage *image = iconName.length > 0 ? [UIImage systemImageNamed:iconName] : nil;
    UIAction *customAction = [UIAction
        actionWithTitle:itemText
                  image:image
             identifier:nil
                handler:^(__kindof UIAction *_) { [weakSelf.inputEventEmitter emitContextMenuItemPress:itemText]; }];
    [allActions addObject:customAction];
  }];

  NSUInteger insertIndex = suggestedActions.count;
  NSMutableArray *systemActions = [suggestedActions mutableCopy];
  for (NSUInteger i = 0; i < systemActions.count; i++) {
    if ([systemActions[i] isKindOfClass:[UIMenu class]]) {
      insertIndex = i + 1;
      break;
    }
  }
  if (menuConfig.format) {
    [systemActions insertObject:formatMenu atIndex:insertIndex];
    insertIndex++;
  }
  if (menuConfig.copyAsMarkdown) {
    [systemActions insertObject:copyMarkdownAction atIndex:insertIndex];
  }
  [allActions addObjectsFromArray:systemActions];

  return [UIMenu menuWithChildren:allActions];
}
#else
- (NSMenu *)enrichedMenuForEvent:(NSEvent *)event defaultMenu:(NSMenu *)menu textView:(NSTextView *)textView
{
  if (textView.selectedRange.length == 0) {
    return menu;
  }

  ENRMInputSelectionMenuConfig menuConfig = [self inputSelectionMenuConfig];
  ENRMFormatMenuConfig fmtConfig = [self formatMenuConfig];
  __weak EnrichedMarkdownTextInput *weakSelf = self;
  NSArray<NSMenuItem *> *customItems =
      ENRMBuildContextMenuItems([self contextMenuItemTexts], [self contextMenuItemIcons], textView,
                                ^(NSString *itemText, NSString *_, NSUInteger __, NSUInteger ___) {
                                  [weakSelf.inputEventEmitter emitContextMenuItemPress:itemText];
                                });
  ENRMPrependMenuItems(menu, customItems);

  [menu addItem:[NSMenuItem separatorItem]];

  if (menuConfig.copyAsMarkdown) {
    NSMenuItem *copyMarkdownItem = [[NSMenuItem alloc] initWithTitle:menuConfig.copyAsMarkdownLabel
                                                              action:@selector(copySelectedRangeAsMarkdown)
                                                       keyEquivalent:@""];
    copyMarkdownItem.target = self;
    [menu addItem:copyMarkdownItem];
  }

  if (menuConfig.format) {
    NSMenu *formatSubmenu = [[NSMenu alloc] initWithTitle:menuConfig.formatLabel];
    const struct {
      NSString *title;
      SEL action;
      NSString *key;
      NSEventModifierFlags modifiers;
      BOOL visible;
    } items[] = {
        {fmtConfig.boldLabel, @selector(toggleBold), @"b", NSEventModifierFlagCommand, fmtConfig.bold},
        {fmtConfig.italicLabel, @selector(toggleItalic), @"i", NSEventModifierFlagCommand, fmtConfig.italic},
        {fmtConfig.underlineLabel, @selector(toggleUnderline), @"u", NSEventModifierFlagCommand, fmtConfig.underline},
        {fmtConfig.strikethroughLabel, @selector(toggleStrikethrough), @"", 0, fmtConfig.strikethrough},
        {fmtConfig.spoilerLabel, @selector(toggleSpoiler), @"", 0, fmtConfig.spoiler},
        {fmtConfig.linkLabel, @selector(showLinkPrompt), @"", 0, fmtConfig.link},
    };

    for (NSUInteger i = 0; i < sizeof(items) / sizeof(items[0]); i++) {
      if (!items[i].visible) {
        continue;
      }
      NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:items[i].title
                                                    action:items[i].action
                                             keyEquivalent:items[i].key];
      if (items[i].modifiers) {
        item.keyEquivalentModifierMask = items[i].modifiers;
      }
      item.target = self;
      [formatSubmenu addItem:item];
    }

    NSMenuItem *formatItem = [[NSMenuItem alloc] initWithTitle:menuConfig.formatLabel action:nil keyEquivalent:@""];
    formatItem.submenu = formatSubmenu;
    [menu addItem:formatItem];
  }

  return menu;
}
#endif

@end
