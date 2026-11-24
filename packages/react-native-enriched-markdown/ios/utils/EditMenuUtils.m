#import "EditMenuUtils.h"
#import "PasteboardUtils.h"
#import "StyleConfig.h"
#include <TargetConditionals.h>

#if !TARGET_OS_OSX

static NSString *const kMenuIdentifierStandardEdit = @"com.apple.menu.standard-edit";
static NSString *const kActionIdentifierCopy = @"com.swmansion.enriched.markdown.copy";
static NSString *const kActionIdentifierCopyMarkdown = @"com.swmansion.enriched.markdown.copyMarkdown";
static NSString *const kActionIdentifierCopyImageURL = @"com.swmansion.enriched.markdown.copyImageURL";

static UIAction *createCopyAction(NSAttributedString *selectedText, NSString *markdown, StyleConfig *styleConfig,
                                  NSString *copyLabel)
{
  return [UIAction actionWithTitle:copyLabel
                             image:[RCTUIImage systemImageNamed:@"doc.on.doc"]
                        identifier:kActionIdentifierCopy
                           handler:^(__kindof UIAction *action) {
                             copyAttributedStringToPasteboard(selectedText, markdown, styleConfig);
                           }];
}

static UIAction *_Nullable createCopyMarkdownAction(NSString *markdown, NSString *copyAsMarkdownLabel)
{
  if (markdown.length == 0)
    return nil;

  return [UIAction actionWithTitle:copyAsMarkdownLabel
                             image:[RCTUIImage systemImageNamed:@"doc.text"]
                        identifier:kActionIdentifierCopyMarkdown
                           handler:^(__kindof UIAction *action) { copyStringToPasteboard(markdown); }];
}

static UIAction *_Nullable createCopyImageURLAction(NSArray<NSString *> *imageURLs,
                                                    ENRMSelectionMenuConfig selectionMenuConfig)
{
  if (imageURLs.count == 0)
    return nil;

  NSString *urlsToCopy = [imageURLs componentsJoinedByString:@"\n"];
  NSString *title = ENRMResolveImageURLsTitle(selectionMenuConfig, imageURLs.count);

  return [UIAction actionWithTitle:title
                             image:[RCTUIImage systemImageNamed:@"link"]
                        identifier:kActionIdentifierCopyImageURL
                           handler:^(__kindof UIAction *action) { copyStringToPasteboard(urlsToCopy); }];
}

/// Rebuilds the standard-edit menu with the system Copy swapped for the enhanced
/// copy action. All other system items are kept — dropping them would remove
/// Select All, which on iOS 16+ is the only way to start a selection from the
/// long-press menu of a non-editable text view.
static UIMenu *createEnhancedStandardEditMenu(UIMenu *originalMenu, UIAction *copyAction)
{
  NSMutableArray<UIMenuElement *> *children = [NSMutableArray arrayWithCapacity:originalMenu.children.count];
  BOOL replacedCopy = NO;

  for (UIMenuElement *element in originalMenu.children) {
    if (!replacedCopy && [element isKindOfClass:[UICommand class]] &&
        ((UICommand *)element).action == @selector(copy:)) {
      [children addObject:copyAction];
      replacedCopy = YES;
      continue;
    }
    [children addObject:element];
  }

  if (!replacedCopy) {
    [children insertObject:copyAction atIndex:0];
  }

  return [UIMenu menuWithTitle:originalMenu.title
                         image:originalMenu.image
                    identifier:originalMenu.identifier
                       options:originalMenu.options
                      children:children];
}

static void addOptionalAction(NSMutableArray<UIMenuElement *> *array, UIAction *_Nullable action)
{
  if (action) {
    [array addObject:action];
  }
}

static void insertOptionalAction(NSMutableArray<UIMenuElement *> *array, UIAction *_Nullable action, NSUInteger index)
{
  if (action) {
    [array insertObject:action atIndex:index];
  }
}

// TODO: Remove API_AVAILABLE(ios(16.0)) guard when the minimum iOS deployment target in RN is bumped to 16.
UIMenu *buildEditMenuForSelection(NSAttributedString *attributedText, NSRange range, NSString *_Nullable cachedMarkdown,
                                  StyleConfig *styleConfig, NSArray<UIMenuElement *> *suggestedActions,
                                  NSArray<UIAction *> *_Nullable customActions,
                                  ENRMSelectionMenuConfig selectionMenuConfig) API_AVAILABLE(ios(16.0))
{
  NSAttributedString *selectedText = [attributedText attributedSubstringFromRange:range];
  NSString *markdown = markdownForRange(attributedText, range, cachedMarkdown);
  NSArray<NSString *> *imageURLs = imageURLsInRange(attributedText, range);

  UIAction *copyAction = createCopyAction(selectedText, markdown, styleConfig, selectionMenuConfig.copyLabel);
  UIAction *copyMarkdownAction = selectionMenuConfig.copyAsMarkdown
                                     ? createCopyMarkdownAction(markdown, selectionMenuConfig.copyAsMarkdownLabel)
                                     : nil;
  UIAction *copyImageURLAction =
      selectionMenuConfig.copyImageURL ? createCopyImageURLAction(imageURLs, selectionMenuConfig) : nil;

  NSMutableArray<UIMenuElement *> *result = [NSMutableArray array];
  BOOL foundStandardEditMenu = NO;

  for (UIMenuElement *element in suggestedActions) {
    if ([element isKindOfClass:[UIMenu class]]) {
      UIMenu *menu = (UIMenu *)element;

      if ([menu.identifier isEqualToString:kMenuIdentifierStandardEdit]) {
        // Replace standard Copy with our enhanced version
        [result addObject:createEnhancedStandardEditMenu(menu, copyAction)];
        addOptionalAction(result, copyMarkdownAction);
        addOptionalAction(result, copyImageURLAction);
        foundStandardEditMenu = YES;
        continue;
      }
    }
    [result addObject:element];
  }

  if (!foundStandardEditMenu) {
    [result insertObject:copyAction atIndex:0];
    insertOptionalAction(result, copyMarkdownAction, 1);
    addOptionalAction(result, copyImageURLAction);
  }

  if (customActions.count > 0) {
    return [UIMenu menuWithChildren:[customActions arrayByAddingObjectsFromArray:result]];
  }

  return [UIMenu menuWithChildren:result];
}

#endif
