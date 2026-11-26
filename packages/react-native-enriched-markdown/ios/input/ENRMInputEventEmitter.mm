#import "ENRMInputEventEmitter.h"

using namespace facebook::react;

static EnrichedMarkdownTextInputEventEmitter::OnChangeState ENRMFabricChangeState(ENRMInputStyleSnapshot s)
{
  return {
      .bold = {.isActive = s.bold},
      .italic = {.isActive = s.italic},
      .underline = {.isActive = s.underline},
      .strikethrough = {.isActive = s.strikethrough},
      .spoiler = {.isActive = s.spoiler},
      .link = {.isActive = s.link, .destination = s.linkDestination},
      .heading = {.isActive = s.headingLevel > 0, .level = static_cast<int>(s.headingLevel)},
      .unorderedList = {.isActive = s.unorderedList, .depth = static_cast<int>(s.unorderedList ? s.listDepth : 0)},
      .orderedList = {.isActive = s.orderedList, .depth = static_cast<int>(s.orderedList ? s.listDepth : 0)},
  };
}

static EnrichedMarkdownTextInputEventEmitter::OnContextMenuItemPressStyleState
ENRMFabricContextMenuStyleState(ENRMInputStyleSnapshot s)
{
  return {
      .bold = {.isActive = s.bold},
      .italic = {.isActive = s.italic},
      .underline = {.isActive = s.underline},
      .strikethrough = {.isActive = s.strikethrough},
      .spoiler = {.isActive = s.spoiler},
      .link = {.isActive = s.link, .destination = s.linkDestination},
      .heading = {.isActive = s.headingLevel > 0, .level = static_cast<int>(s.headingLevel)},
      .unorderedList = {.isActive = s.unorderedList, .depth = static_cast<int>(s.unorderedList ? s.listDepth : 0)},
      .orderedList = {.isActive = s.orderedList, .depth = static_cast<int>(s.orderedList ? s.listDepth : 0)},
  };
}

#define ENRM_GUARD_EMITTER(name)                                                                                       \
  auto name = [self emitter];                                                                                          \
  if (name == nullptr) {                                                                                               \
    return;                                                                                                            \
  }

@implementation ENRMInputEventEmitter {
  __weak id<ENRMInputEventEmitterDataSource> _dataSource;

  struct {
    BOOL bold, italic, underline, strikethrough, spoiler, link, initialized;
    std::string linkDestination;
    NSInteger headingLevel;
    BOOL unorderedList;
    NSInteger unorderedListDepth;
    BOOL orderedList;
    NSInteger orderedListDepth;
  } _prevState;

  std::optional<CGRect> _prevCaretRect;
}

- (instancetype)initWithDataSource:(id<ENRMInputEventEmitterDataSource>)dataSource
{
  self = [super init];
  if (self) {
    _dataSource = dataSource;
  }
  return self;
}

#pragma mark - Private

- (std::shared_ptr<EnrichedMarkdownTextInputEventEmitter const>)emitter
{
  return [_dataSource fabricEventEmitter];
}

#pragma mark - Simple emitters

- (void)emitOnChangeText
{
  ENRM_GUARD_EMITTER(emitter);
  NSString *plainText = [_dataSource plainText];
  emitter->onChangeText({.value = std::string([plainText UTF8String] ?: "")});
}

/// Maps the replacement text of a pending edit to RN TextInput's
/// `onKeyPress` key names: empty text means deletion ("Backspace"), and
/// leading \n, \t and ESC map to "Enter", "Tab" and "Escape".
- (void)emitOnKeyPress:(NSString *)text
{
  ENRM_GUARD_EMITTER(emitter);
  NSString *key;
  if (text.length == 0) {
    key = @"Backspace";
  } else {
    switch ([text characterAtIndex:0]) {
      case '\n':
        key = @"Enter";
        break;
      case '\t':
        key = @"Tab";
        break;
      case 0x1B:
        key = @"Escape";
        break;
      default:
        key = text;
        break;
    }
  }
  emitter->onInputKeyPress({.key = std::string([key UTF8String] ?: "")});
}

- (void)emitOnChangeMarkdown
{
  ENRM_GUARD_EMITTER(emitter);
  NSString *markdown = [_dataSource currentMarkdown];
  emitter->onChangeMarkdown({.value = std::string([markdown UTF8String] ?: "")});
}

- (void)emitOnChangeSelection
{
  ENRM_GUARD_EMITTER(emitter);
  NSRange selection = [_dataSource selectedRange];
  emitter->onChangeSelection({
      .start = static_cast<int>(selection.location),
      .end = static_cast<int>(NSMaxRange(selection)),
  });
}

- (void)emitOnFocus
{
  ENRM_GUARD_EMITTER(emitter);
  emitter->onInputFocus({});
}

- (void)emitOnBlur
{
  ENRM_GUARD_EMITTER(emitter);
  emitter->onInputBlur({});
}

- (void)emitOnLinkDetectedWithText:(NSString *)text url:(NSString *)url range:(NSRange)range
{
  ENRM_GUARD_EMITTER(emitter);
  emitter->onLinkDetected({
      .text = std::string([text UTF8String] ?: ""),
      .url = std::string([url UTF8String] ?: ""),
      .start = static_cast<int>(range.location),
      .end = static_cast<int>(range.location + range.length),
  });
}

- (void)emitOnStartMention:(NSString *)indicator
{
  ENRM_GUARD_EMITTER(emitter);
  emitter->onStartMention({.indicator = std::string([indicator UTF8String] ?: "")});
}

- (void)emitOnChangeMentionWithIndicator:(NSString *)indicator text:(NSString *)text
{
  ENRM_GUARD_EMITTER(emitter);
  emitter->onChangeMention({
      .indicator = std::string([indicator UTF8String] ?: ""),
      .text = std::string([text UTF8String] ?: ""),
  });
}

- (void)emitOnEndMention:(NSString *)indicator
{
  ENRM_GUARD_EMITTER(emitter);
  emitter->onEndMention({.indicator = std::string([indicator UTF8String] ?: "")});
}

#pragma mark - Stateful emitters

- (void)emitOnChangeState
{
  ENRM_GUARD_EMITTER(emitter);

  ENRMInputStyleSnapshot snapshot = [ENRMInputStyleStateBuilder snapshotAtCurrentCursor:_dataSource];

  if (_prevState.initialized && _prevState.bold == snapshot.bold && _prevState.italic == snapshot.italic &&
      _prevState.underline == snapshot.underline && _prevState.strikethrough == snapshot.strikethrough &&
      _prevState.spoiler == snapshot.spoiler && _prevState.link == snapshot.link &&
      _prevState.linkDestination == snapshot.linkDestination && _prevState.headingLevel == snapshot.headingLevel &&
      _prevState.unorderedList == snapshot.unorderedList && _prevState.unorderedListDepth == snapshot.listDepth &&
      _prevState.orderedList == snapshot.orderedList && _prevState.orderedListDepth == snapshot.listDepth) {
    return;
  }

  _prevState.bold = snapshot.bold;
  _prevState.italic = snapshot.italic;
  _prevState.underline = snapshot.underline;
  _prevState.strikethrough = snapshot.strikethrough;
  _prevState.spoiler = snapshot.spoiler;
  _prevState.link = snapshot.link;
  _prevState.linkDestination = snapshot.linkDestination;
  _prevState.headingLevel = snapshot.headingLevel;
  _prevState.unorderedList = snapshot.unorderedList;
  _prevState.unorderedListDepth = snapshot.listDepth;
  _prevState.orderedList = snapshot.orderedList;
  _prevState.orderedListDepth = snapshot.listDepth;
  _prevState.initialized = YES;

  emitter->onChangeState(ENRMFabricChangeState(snapshot));
}

- (void)emitCaretRectChangeIfNeeded
{
  ENRM_GUARD_EMITTER(emitter);

  CGRect caretRect = [_dataSource computeCaretRect];

  if (_prevCaretRect.has_value() && CGRectEqualToRect(_prevCaretRect.value(), caretRect)) {
    return;
  }

  _prevCaretRect = caretRect;

  emitter->onCaretRectChange({
      .x = caretRect.origin.x,
      .y = caretRect.origin.y,
      .width = caretRect.size.width,
      .height = caretRect.size.height,
  });
}

- (void)invalidateCachedState
{
  _prevState.initialized = NO;
  _prevCaretRect.reset();
}

- (void)emitContextMenuItemPress:(NSString *)itemText
{
  ENRM_GUARD_EMITTER(eventEmitter);

  NSRange selectedRange = [_dataSource selectedRange];
  NSString *selectedText = selectedRange.length > 0 ? [[_dataSource plainText] substringWithRange:selectedRange] : @"";

  ENRMInputStyleSnapshot snapshot = [ENRMInputStyleStateBuilder snapshotForRange:selectedRange dataSource:_dataSource];

  eventEmitter->onContextMenuItemPress({
      .itemText = std::string(itemText.UTF8String),
      .selectedText = std::string(selectedText.UTF8String),
      .selectionStart = static_cast<int>(selectedRange.location),
      .selectionEnd = static_cast<int>(NSMaxRange(selectedRange)),
      .styleState = ENRMFabricContextMenuStyleState(snapshot),
  });
}

#pragma mark - Compound helpers

- (void)emitFormattingChanged
{
  [self emitOnChangeState];
  if (_emitMarkdown) {
    [self emitOnChangeMarkdown];
  }
}

#pragma mark - Request-response

- (void)requestMarkdown:(NSInteger)requestId
{
  ENRM_GUARD_EMITTER(emitter);
  NSString *markdown = [_dataSource currentMarkdown];
  emitter->onRequestMarkdownResult({
      .requestId = static_cast<int>(requestId),
      .markdown = std::string([markdown UTF8String] ?: ""),
  });
}

- (void)requestCaretRect:(NSInteger)requestId
{
  ENRM_GUARD_EMITTER(emitter);

  CGRect caretRect = [_dataSource computeCaretRect];
  emitter->onRequestCaretRectResult({
      .requestId = static_cast<int>(requestId),
      .x = caretRect.origin.x,
      .y = caretRect.origin.y,
      .width = caretRect.size.width,
      .height = caretRect.size.height,
  });
}

@end
