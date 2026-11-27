#pragma once

#import "ENRMInputEventEmitter.h"
#import "ENRMInputStyledRange.h"
#import "ENRMInputTypingAttributesController.h"
#import "EnrichedMarkdownTextInput.h"

NS_ASSUME_NONNULL_BEGIN

// The owner must keep these strings alive for the duration of the call (the
// view holds them in strong ivars).
typedef struct {
  BOOL format;
  __unsafe_unretained NSString *_Nullable formatLabel;
  BOOL copyAsMarkdown;
  __unsafe_unretained NSString *_Nullable copyAsMarkdownLabel;
} ENRMInputSelectionMenuConfig;

typedef struct {
  BOOL bold;
  __unsafe_unretained NSString *_Nullable boldLabel;
  BOOL italic;
  __unsafe_unretained NSString *_Nullable italicLabel;
  BOOL underline;
  __unsafe_unretained NSString *_Nullable underlineLabel;
  BOOL strikethrough;
  __unsafe_unretained NSString *_Nullable strikethroughLabel;
  BOOL spoiler;
  __unsafe_unretained NSString *_Nullable spoilerLabel;
  BOOL link;
  __unsafe_unretained NSString *_Nullable linkLabel;
} ENRMFormatMenuConfig;

@interface EnrichedMarkdownTextInput (Internal)

@property (nonatomic, readonly) ENRMInputEventEmitter *inputEventEmitter;
@property (nonatomic, readonly) ENRMInputTypingAttributesController *typingController;

- (void)toggleBold;
- (void)toggleItalic;
- (void)toggleUnderline;
- (void)toggleStrikethrough;
- (void)toggleSpoiler;
- (void)toggleInlineStyle:(ENRMInputStyleType)type;
- (void)toggleHeading:(NSInteger)level;
- (void)toggleUnorderedList;
- (void)toggleOrderedList;
- (void)indentList;
- (void)outdentList;
- (BOOL)handleBackspaceAtDocumentStart;
- (void)showLinkPrompt;

- (NSArray<NSString *> *)contextMenuItemTexts;
- (NSArray<NSString *> *)contextMenuItemIcons;
- (ENRMInputSelectionMenuConfig)inputSelectionMenuConfig;
- (ENRMFormatMenuConfig)formatMenuConfig;

#if TARGET_OS_OSX
- (NSMenu *)enrichedMenuForEvent:(NSEvent *)event defaultMenu:(NSMenu *)menu textView:(NSTextView *)textView;
#endif

@end

NS_ASSUME_NONNULL_END
