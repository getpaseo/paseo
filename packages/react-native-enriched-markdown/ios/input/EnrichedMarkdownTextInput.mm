#import "EnrichedMarkdownTextInput.h"
#import "ContextMenuUtils.h"
#import "ENRMAutoLinkDetector.h"
#import "ENRMBlockEditCoordinator.h"
#import "ENRMBlockHandler.h"
#import "ENRMBlockStore.h"
#import "ENRMClipboardCoordinator.h"
#import "ENRMDetectorPipeline.h"
#import "ENRMEditPipeline.h"
#import "ENRMEditSession.h"
#import "ENRMFormattingRange.h"
#import "ENRMFormattingStore.h"
#import "ENRMInputEventEmitter.h"
#import "ENRMInputFormatter.h"
#import "ENRMInputLayoutManager.h"
#import "ENRMInputLinkPrompt.h"
#import "ENRMInputListMarkerDrawer.h"
#import "ENRMInputParser.h"
#import "ENRMInputTextView.h"
#import "ENRMInputTypingAttributesController.h"
#import "ENRMLinkCoordinator.h"
#import "ENRMLinkRegexConfig.h"
#import "ENRMMarkdownShortcutMatcher.h"
#import "ENRMMentionCoordinator.h"
#import "ENRMStyleHandler.h"
#import "ENRMStyleMergingConfig.h"
#import "ENRMUIKit.h"
#import "ENRMViewFreeMeasurement.h"
#import "EnrichedMarkdownTextInput+Internal.h"
#import "InputStylePropsUtils.h"
#import "ParagraphStyleUtils.h"
#import "PasteboardUtils.h"
#import "SelectionColorUtils.h"
#import "StyleConfig.h"
#import <QuartzCore/CABase.h>
#import <React/RCTI18nUtil.h>
#if TARGET_OS_OSX
#import <React/RCTBackedTextInputDelegate.h>
#endif

#import <ReactNativeEnrichedMarkdown/EnrichedMarkdownTextInputComponentDescriptor.h>
#import <ReactNativeEnrichedMarkdown/EventEmitters.h>
#import <ReactNativeEnrichedMarkdown/Props.h>
#import <ReactNativeEnrichedMarkdown/RCTComponentViewHelpers.h>

#import "EnrichedMarkdownTextInputShadowNode.h"
#import "HeightUpdateUtils.h"
#import "RCTFabricComponentsPlugins.h"
#import <React/RCTConversions.h>

using namespace facebook::react;

#if !TARGET_OS_OSX
@interface EnrichedMarkdownTextInput () <RCTEnrichedMarkdownTextInputViewProtocol, UITextViewDelegate,
                                         ENRMEditPipelineHost, ENRMInputEventEmitterDataSource,
                                         ENRMInputTypingAttributesDataSource>
#else
@interface EnrichedMarkdownTextInput () <RCTEnrichedMarkdownTextInputViewProtocol, RCTBackedTextInputDelegate,
                                         ENRMEditPipelineHost, ENRMInputEventEmitterDataSource,
                                         ENRMInputTypingAttributesDataSource>
#endif
- (void)setupTextView;
- (void)applyFormatting;
- (void)applyFormattingScopedToEditAtLocation:(NSUInteger)editLocation insertedLength:(NSUInteger)insertedLength;
- (void)applyFormattingScopedFromParagraphAtLocation:(NSUInteger)editLocation;
- (void)toggleInlineStyle:(ENRMInputStyleType)styleType;
- (void)resetBaseTypingAttributes;
@end

static const NSTimeInterval kENRMAtomicSnapPollInterval = 0.1;

@implementation EnrichedMarkdownTextInput {
  ENRMPlatformTextView *_textView;
  ENRMInputLayoutManager *_layoutManager;
  EnrichedMarkdownTextInputShadowNode::ConcreteState::Shared _state;
  int _heightUpdateCounter;
  ENRMInputFormatter *_formatter;
  ENRMInputFormatterStyle *_formatterStyle;
  ENRMFormattingStore *_formattingStore;
  ENRMBlockStore *_blockStore;
  ENRMInputTypingAttributesController *_typingController;
  ENRMInputEventEmitter *_inputEventEmitter;
  ENRMEditSession *_editSession;

  ENRMPlaceholderLabel *_placeholderLabel;
  NSString *_placeholderText;

  NSUInteger _lastTextLength;
  NSRange _lastSelectedRange;
  NSRange _preEditSelectedRange;
  BOOL _atomicSnapScheduled;

  // Block type/level of the line being edited, captured before a text change so
  // a Return that continues a list (or an autocorrect/paste that replaces the
  // line) can restore the right block on the resulting line(s).
  ENRMInputBlockType _preEditBlockType;
  NSInteger _preEditBlockLevel;
  BOOL _preEditParagraphWasEmpty;
  // Whether the replaced range contained a line break, captured before the edit
  // applies (the deleted characters are gone afterwards). Drives the full-vs-
  // scoped reformat decision in handleTextChanged.
  BOOL _preEditReplacedNewline;

#if TARGET_OS_OSX
  NSScrollView *_scrollView;
#endif

  NSArray<NSString *> *_contextMenuItemTexts;
  NSArray<NSString *> *_contextMenuItemIcons;
  ENRMAutoLinkDetector *_autoLinkDetector;
  ENRMDetectorPipeline *_detectorPipeline;
  ENRMEditPipeline *_editPipeline;
  ENRMBlockEditCoordinator *_blockCoordinator;
  ENRMMentionCoordinator *_mentionCoordinator;
  ENRMLinkCoordinator *_linkCoordinator;
  ENRMClipboardCoordinator *_clipboardCoordinator;

  ENRMMarkdownShortcutsConfig _markdownShortcutsConfig;
  ENRMWritingDirectionMode _writingDirectionMode;
  NSWritingDirection _resolvedLayoutDirection;

  ENRMInputSelectionMenuConfig _inputSelectionMenuConfig;
  ENRMFormatMenuConfig _formatMenuConfig;

  // Strong owners for the strings the two config structs above reference via
  // `__unsafe_unretained` pointers.
  NSString *_inputSelectionMenuFormatLabel;
  NSString *_inputSelectionMenuCopyAsMarkdownLabel;
  NSString *_formatMenuBoldLabel;
  NSString *_formatMenuItalicLabel;
  NSString *_formatMenuUnderlineLabel;
  NSString *_formatMenuStrikethroughLabel;
  NSString *_formatMenuSpoilerLabel;
  NSString *_formatMenuLinkLabel;
}

@synthesize editSession = _editSession;

#pragma mark - Fabric lifecycle

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<EnrichedMarkdownTextInputComponentDescriptor>();
}

+ (BOOL)shouldBeRecycled
{
  return NO;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const EnrichedMarkdownTextInputProps>();
    _props = defaultProps;

    self.backgroundColor = [RCTUIColor clearColor];
    _heightUpdateCounter = 0;
    _formatter = [[ENRMInputFormatter alloc] init];
    _formatterStyle = [[ENRMInputFormatterStyle alloc] init];
    _formattingStore = [[ENRMFormattingStore alloc] init];
    _blockStore = [[ENRMBlockStore alloc] init];
    _lastTextLength = 0;
    _lastSelectedRange = NSMakeRange(0, 0);
    _mentionCoordinator = [[ENRMMentionCoordinator alloc] initWithFormattingStore:_formattingStore];

    _writingDirectionMode = ENRMWritingDirectionModeFirstStrong;
    _resolvedLayoutDirection =
        [[RCTI18nUtil sharedInstance] isRTL] ? NSWritingDirectionRightToLeft : NSWritingDirectionLeftToRight;
    _inputSelectionMenuConfig = (ENRMInputSelectionMenuConfig){.format = YES, .copyAsMarkdown = YES};
    _formatMenuConfig = (ENRMFormatMenuConfig){
        .bold = YES, .italic = YES, .underline = YES, .strikethrough = YES, .spoiler = YES, .link = YES};

    [self setupTextView];
    _editSession = [[ENRMEditSession alloc] initWithTextView:_textView];
    _typingController = [[ENRMInputTypingAttributesController alloc] initWithTextView:_textView
                                                                       formatterStyle:_formatterStyle
                                                                           dataSource:self
                                                                          editSession:_editSession];
    _inputEventEmitter = [[ENRMInputEventEmitter alloc] initWithDataSource:self];

    [self setupDetectorPipeline];

    _editPipeline = [[ENRMEditPipeline alloc] initWithFormattingStore:_formattingStore
                                                           blockStore:_blockStore
                                                            formatter:_formatter
                                                     detectorPipeline:_detectorPipeline
                                                                 host:self];
    _blockCoordinator = [[ENRMBlockEditCoordinator alloc] initWithBlockStore:_blockStore];
    _linkCoordinator = [[ENRMLinkCoordinator alloc] initWithFormattingStore:_formattingStore
                                                           autoLinkDetector:_autoLinkDetector];
    _clipboardCoordinator = [[ENRMClipboardCoordinator alloc] initWithFormattingStore:_formattingStore
                                                                           blockStore:_blockStore
                                                               transientRangeProvider:_detectorPipeline
                                                                            formatter:_formatter];
  }
  return self;
}

- (void)setupDetectorPipeline
{
  _autoLinkDetector = [[ENRMAutoLinkDetector alloc] initWithTextStorage:_textView.textStorage
                                                        formattingStore:_formattingStore
                                                                  style:_formatterStyle];

  __weak EnrichedMarkdownTextInput *weakSelf = self;
  _autoLinkDetector.onLinkDetected = ^(NSString *text, NSString *url, NSRange range) {
    EnrichedMarkdownTextInput *strongSelf = weakSelf;
    if (strongSelf == nil) {
      return;
    }
    [strongSelf->_inputEventEmitter emitOnLinkDetectedWithText:text url:url range:range];
  };

  _detectorPipeline = [[ENRMDetectorPipeline alloc] init];
  [_detectorPipeline addDetector:_autoLinkDetector];
}

- (void)setupTextView
{
#if !TARGET_OS_OSX
  _layoutManager = [[ENRMInputLayoutManager alloc] init];
  _layoutManager.usesFontLeading = ENRMLayoutManagerUsesFontLeading;
  NSTextContainer *textContainer = [[NSTextContainer alloc] initWithSize:CGSizeMake(0, CGFLOAT_MAX)];
  textContainer.widthTracksTextView = YES;
  [_layoutManager addTextContainer:textContainer];

  NSTextStorage *textStorage = [[NSTextStorage alloc] init];
  [textStorage addLayoutManager:_layoutManager];

  ENRMInputTextView *inputTextView = [[ENRMInputTextView alloc] initWithFrame:CGRectZero textContainer:textContainer];
#else
  ENRMInputTextView *inputTextView = [[ENRMInputTextView alloc] initWithFrame:CGRectZero];
  _layoutManager = [[ENRMInputLayoutManager alloc] init];
  _layoutManager.usesFontLeading = ENRMLayoutManagerUsesFontLeading;
  [inputTextView.textContainer replaceLayoutManager:_layoutManager];
#endif
  inputTextView.markdownTextInput = self;
  _textView = inputTextView;
  ENRMConfigureMarkdownTextInputTextView(_textView);
#if !TARGET_OS_OSX
  _textView.adjustsFontForContentSizeCategory = YES;
  _textView.delegate = self;
#else
  _textView.textInputDelegate = self;
#endif

#if !TARGET_OS_OSX
  self.contentView = _textView;
#else
  _textView.selectable = YES;

  _scrollView = [[NSScrollView alloc] initWithFrame:CGRectZero];
  _scrollView.backgroundColor = [RCTUIColor clearColor];
  _scrollView.drawsBackground = NO;
  _scrollView.borderType = NSNoBorder;
  _scrollView.hasHorizontalRuler = NO;
  _scrollView.hasVerticalRuler = NO;
  _scrollView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  _textView.verticallyResizable = YES;
  _textView.horizontallyResizable = YES;
  _textView.textContainer.containerSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
  _textView.textContainer.widthTracksTextView = YES;

  _scrollView.documentView = _textView;
  self.contentView = _scrollView;
#endif

  _placeholderLabel = ENRMCreatePlaceholderLabel(_textView, _formatterStyle.baseFont);
#if !TARGET_OS_OSX
  _placeholderLabel.adjustsFontForContentSizeCategory = YES;
  _placeholderLabel.accessibilityElementsHidden = YES;
  _placeholderLabel.isAccessibilityElement = NO;
#endif

  [self resetBaseTypingAttributes];
}

#if !TARGET_OS_OSX
#pragma mark - Accessibility

// The custom TextKit 1 stack leaves the inner UITextView invisible to VoiceOver, so
// the host vends the content itself as one readable element.
- (BOOL)isAccessibilityElement
{
  return YES;
}

- (NSString *)accessibilityValue
{
  NSString *text = ENRMGetPlainText(_textView);
  if (text.length > 0) {
    return text;
  }
  if (_placeholderLabel.text.length > 0) {
    return _placeholderLabel.text;
  }
  return [super accessibilityValue];
}

- (BOOL)accessibilityActivate
{
  ENRMFocusTextView(_textView);
  [super accessibilityActivate];
  return YES;
}
#endif

#pragma mark - State

- (void)updateState:(const facebook::react::State::Shared &)state
           oldState:(const facebook::react::State::Shared &)oldState
{
  _state = std::static_pointer_cast<const EnrichedMarkdownTextInputShadowNode::ConcreteState>(state);

  if (oldState == nullptr) {
    [self requestHeightUpdate];
  }
}

- (void)requestHeightUpdate
{
  ENRMRequestHeightUpdate<EnrichedMarkdownTextInputState>(_state, _heightUpdateCounter, self);
}

/// Yoga-resolved direction inherited from any ancestor `direction` style.
/// In FirstStrong mode this feeds the neutral-paragraph fallback, so a change
/// requires re-resolving per-paragraph directions over the current text.
- (void)updateLayoutMetrics:(const LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const LayoutMetrics &)oldLayoutMetrics
{
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:oldLayoutMetrics];

  NSWritingDirection resolved = _resolvedLayoutDirection;
  if (layoutMetrics.layoutDirection == LayoutDirection::RightToLeft) {
    resolved = NSWritingDirectionRightToLeft;
  } else if (layoutMetrics.layoutDirection == LayoutDirection::LeftToRight) {
    resolved = NSWritingDirectionLeftToRight;
  }

  if (resolved != _resolvedLayoutDirection) {
    _resolvedLayoutDirection = resolved;
    if (_writingDirectionMode == ENRMWritingDirectionModeFirstStrong && _textView.textStorage.length > 0) {
      [self applyFormatting];
    }
  }
}

#pragma mark - Measurement

- (CGSize)measureSize:(CGFloat)maxWidth
{
  NSMutableAttributedString *measuredText =
      [[NSMutableAttributedString alloc] initWithAttributedString:ENRMGetAttributedText(_textView)];

  // Empty input should still be the height of a single line.
  // Use typingAttributes so the measurement matches the actual configured font.
  if (measuredText.length == 0) {
    [measuredText appendAttributedString:[[NSAttributedString alloc] initWithString:@"I"
                                                                         attributes:_textView.typingAttributes]];
  }

  // Same TextKit path as the read-only view, with font leading off. The extra
  // line fragment after a trailing newline is kept so that blank line counts
  // toward the height, as in RN TextInput.
  StyleConfig *config = [[StyleConfig alloc] init];
  CGSize size = ENRMMeasureAttributedTextViewFree(measuredText, maxWidth, config, NO, 0, RCTScreenScale(), 0,
                                                  NSLineBreakByWordWrapping, NO);
  return CGSizeMake(maxWidth, size.height);
}

#pragma mark - Props

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<EnrichedMarkdownTextInputProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<EnrichedMarkdownTextInputProps const>(props);

  if (newViewProps.editable != oldViewProps.editable) {
    _textView.editable = newViewProps.editable;
  }

  // Copied unconditionally: the generated struct only has `operator==` under
  // RN_SERIALIZABLE_STATE, and three BOOLs are cheaper than the comparison.
  _markdownShortcutsConfig = (ENRMMarkdownShortcutsConfig){
      .heading = newViewProps.markdownShortcuts.heading,
      .unorderedList = newViewProps.markdownShortcuts.unorderedList,
      .orderedList = newViewProps.markdownShortcuts.orderedList,
  };

#if !TARGET_OS_OSX
  if (newViewProps.scrollEnabled != oldViewProps.scrollEnabled) {
    _textView.scrollEnabled = newViewProps.scrollEnabled;
  }

  if (newViewProps.autoCapitalize != oldViewProps.autoCapitalize) {
    NSString *value = [NSString stringWithUTF8String:newViewProps.autoCapitalize.c_str()];
    _textView.autocapitalizationType = ENRMAutocapitalizationTypeFromString(value);
    if ([_textView isFirstResponder]) {
      [_textView resignFirstResponder];
      [_textView becomeFirstResponder];
    }
  }

  if (newViewProps.multiline != oldViewProps.multiline) {
    _textView.textContainer.maximumNumberOfLines = newViewProps.multiline ? 0 : 1;
    _textView.textContainer.lineBreakMode =
        newViewProps.multiline ? NSLineBreakByWordWrapping : NSLineBreakByTruncatingTail;
  }
#endif

  if (newViewProps.placeholder != oldViewProps.placeholder) {
    _placeholderText = [NSString stringWithUTF8String:newViewProps.placeholder.c_str()];
    [self updatePlaceholderText];
  }

  if (newViewProps.placeholderTextColor != oldViewProps.placeholderTextColor) {
    if (isColorMeaningful(newViewProps.placeholderTextColor)) {
      _placeholderLabel.textColor = RCTUIColorFromSharedColor(newViewProps.placeholderTextColor);
      [self updatePlaceholderText];
    }
  }

  if (newViewProps.cursorColor != oldViewProps.cursorColor) {
    if (isColorMeaningful(newViewProps.cursorColor)) {
      ENRMSetCursorColor(_textView, RCTUIColorFromSharedColor(newViewProps.cursorColor));
    }
  }

  if (newViewProps.selectionColor != oldViewProps.selectionColor) {
    ENRMApplySelectionColor(_textView, newViewProps.selectionColor);
  }

  _inputEventEmitter.emitMarkdown = newViewProps.isOnChangeMarkdownSet;

  {
    auto configFromProp = [](const auto &prop) {
      return [[ENRMLinkRegexConfig alloc] initWithPattern:[NSString stringWithUTF8String:prop.pattern.c_str()]
                                          caseInsensitive:prop.caseInsensitive
                                                   dotAll:prop.dotAll
                                               isDisabled:prop.isDisabled
                                                isDefault:prop.isDefault];
    };
    ENRMLinkRegexConfig *oldRegexConfig = configFromProp(oldViewProps.linkRegex);
    ENRMLinkRegexConfig *newRegexConfig = configFromProp(newViewProps.linkRegex);
    if (![newRegexConfig isEqualToConfig:oldRegexConfig]) {
      [_autoLinkDetector setRegexConfig:newRegexConfig];
    }
  }

  if (ENRMContextMenuItemsChanged(oldViewProps.contextMenuItems, newViewProps.contextMenuItems)) {
    _contextMenuItemTexts = ENRMContextMenuTextsFromItems(newViewProps.contextMenuItems);
    _contextMenuItemIcons = ENRMContextMenuIconsFromItems(newViewProps.contextMenuItems);
  }

  // Coalesce against `initWithUTF8String:` returning nil on malformed UTF-8 —
  // UIMenu / UIAction / NSMenuItem titles are _Nonnull and would crash.
  _inputSelectionMenuFormatLabel =
      [[NSString alloc] initWithUTF8String:newViewProps.selectionMenuConfig.formatLabel.c_str()] ?: @"";
  _inputSelectionMenuCopyAsMarkdownLabel =
      [[NSString alloc] initWithUTF8String:newViewProps.selectionMenuConfig.copyAsMarkdownLabel.c_str()] ?: @"";
  _inputSelectionMenuConfig = (ENRMInputSelectionMenuConfig){
      .format = newViewProps.selectionMenuConfig.format,
      .formatLabel = _inputSelectionMenuFormatLabel,
      .copyAsMarkdown = newViewProps.selectionMenuConfig.copyAsMarkdown,
      .copyAsMarkdownLabel = _inputSelectionMenuCopyAsMarkdownLabel,
  };

  _formatMenuBoldLabel = [[NSString alloc] initWithUTF8String:newViewProps.formatMenuConfig.boldLabel.c_str()] ?: @"";
  _formatMenuItalicLabel =
      [[NSString alloc] initWithUTF8String:newViewProps.formatMenuConfig.italicLabel.c_str()] ?: @"";
  _formatMenuUnderlineLabel =
      [[NSString alloc] initWithUTF8String:newViewProps.formatMenuConfig.underlineLabel.c_str()] ?: @"";
  _formatMenuStrikethroughLabel =
      [[NSString alloc] initWithUTF8String:newViewProps.formatMenuConfig.strikethroughLabel.c_str()] ?: @"";
  _formatMenuSpoilerLabel =
      [[NSString alloc] initWithUTF8String:newViewProps.formatMenuConfig.spoilerLabel.c_str()] ?: @"";
  _formatMenuLinkLabel = [[NSString alloc] initWithUTF8String:newViewProps.formatMenuConfig.linkLabel.c_str()] ?: @"";
  _formatMenuConfig = (ENRMFormatMenuConfig){
      .bold = newViewProps.formatMenuConfig.bold,
      .boldLabel = _formatMenuBoldLabel,
      .italic = newViewProps.formatMenuConfig.italic,
      .italicLabel = _formatMenuItalicLabel,
      .underline = newViewProps.formatMenuConfig.underline,
      .underlineLabel = _formatMenuUnderlineLabel,
      .strikethrough = newViewProps.formatMenuConfig.strikethrough,
      .strikethroughLabel = _formatMenuStrikethroughLabel,
      .spoiler = newViewProps.formatMenuConfig.spoiler,
      .spoilerLabel = _formatMenuSpoilerLabel,
      .link = newViewProps.formatMenuConfig.link,
      .linkLabel = _formatMenuLinkLabel,
  };

  if (newViewProps.mentionIndicators != oldViewProps.mentionIndicators) {
    NSMutableArray<NSString *> *indicators = [NSMutableArray array];
    for (const auto &indicator : newViewProps.mentionIndicators) {
      NSString *value = [NSString stringWithUTF8String:indicator.c_str()];
      if (value.length > 0) {
        [indicators addObject:value];
      }
    }
    [self dispatchMentionEvents:[_mentionCoordinator setIndicators:indicators]];
    [self dispatchMentionUpdate];
  }

  BOOL styleChanged = applyInputStyleProps(_formatterStyle, newViewProps, oldViewProps);

  BOOL writingDirectionChanged = NO;
  if (newViewProps.writingDirection != oldViewProps.writingDirection) {
    NSString *value = [[NSString alloc] initWithUTF8String:newViewProps.writingDirection.c_str()];
    _writingDirectionMode = ENRMResolveWritingDirectionMode(value);
    writingDirectionChanged = YES;
  }

  if (newViewProps.defaultValue != oldViewProps.defaultValue) {
    if (!newViewProps.defaultValue.empty() && oldViewProps.defaultValue.empty()) {
      NSString *markdown = [NSString stringWithUTF8String:newViewProps.defaultValue.c_str()];
      [self importMarkdown:markdown];
    }
  }

  if (styleChanged) {
    [self updatePlaceholderText];

    [self resetBaseTypingAttributes];
    [self applyFormatting];
    [self requestHeightUpdate];
  } else if (writingDirectionChanged && _textView.textStorage.length > 0) {
    [self applyFormatting];
  }

  [super updateProps:props oldProps:oldProps];
}

#pragma mark - Relayout

- (void)scheduleRelayoutIfNeeded
{
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(_performRelayout) object:nil];
  [self performSelector:@selector(_performRelayout) withObject:nil afterDelay:0];
}

- (void)_performRelayout
{
  if (!_textView) {
    return;
  }

  NSUInteger textLength = _textView.textStorage.length;
  if (textLength == 0) {
    return;
  }

  NSRange wholeRange = NSMakeRange(0, textLength);
  [_textView.layoutManager invalidateLayoutForCharacterRange:wholeRange actualCharacterRange:NULL];
  [_textView.layoutManager ensureLayoutForTextContainer:_textView.textContainer];
  [_textView.layoutManager invalidateDisplayForCharacterRange:wholeRange];

  CGSize measuredSize = [self measureSize:_textView.frame.size.width];
  CGSize currentSize = _textView.contentSize;
  BOOL sizeChanged =
      fabs(currentSize.width - measuredSize.width) > 0.5 || fabs(currentSize.height - measuredSize.height) > 0.5;
  if (sizeChanged) {
    ENRMSetContentSize(_textView, measuredSize);
  }
}

#pragma mark - Window attachment

- (void)didMoveToWindow
{
  [super didMoveToWindow];

  if (self.window) {
    // Don't override the contentView frame set by RCTViewComponentView.
    ENRMRefreshTextViewLayout(_textView);

    [self applyFormatting];
    [self updatePlaceholderVisibility];
    [self requestHeightUpdate];

    const auto &viewProps = *std::static_pointer_cast<EnrichedMarkdownTextInputProps const>(_props);
    if (viewProps.autoFocus) {
      ENRMFocusTextView(_textView);
    }
  }
}

#if TARGET_OS_OSX

#pragma mark - macOS responder chain

- (BOOL)acceptsFirstResponder
{
  return _textView.acceptsFirstResponder;
}

- (BOOL)becomeFirstResponder
{
  return [self.window makeFirstResponder:_textView];
}

- (BOOL)needsPanelToBecomeKey
{
  return YES;
}

- (BOOL)mouseDownCanMoveWindow
{
  return NO;
}

- (void)mouseDown:(NSEvent *)event
{
  [self.window makeFirstResponder:_textView];
  [_textView mouseDown:event];
}

#endif

#if !TARGET_OS_OSX
- (void)traitCollectionDidChange:(UITraitCollection *)previousTraitCollection
{
  [super traitCollectionDidChange:previousTraitCollection];

  if (previousTraitCollection.preferredContentSizeCategory != self.traitCollection.preferredContentSizeCategory) {
    [_formatterStyle invalidateFontCache];

    [self resetBaseTypingAttributes];

    [self updatePlaceholderText];

    [self applyFormatting];
    [self requestHeightUpdate];
  }
}
#endif

#pragma mark - ENRMEditPipelineHost

- (NSString *)plainText
{
  return ENRMGetPlainText(_textView);
}

- (NSTextStorage *)textStorage
{
  return _textView.textStorage;
}

#pragma mark - Placeholder

/// Lays the placeholder out like a body paragraph: base font, and the body line
/// height with the same baseline centering the formatter applies to typed text.
- (void)updatePlaceholderText
{
  NSMutableDictionary *attrs = [@{
    NSFontAttributeName : _formatterStyle.baseFont,
    NSForegroundColorAttributeName : _placeholderLabel.textColor,
  } mutableCopy];
  if (_formatterStyle.baseLineHeight > 0) {
    attrs[NSParagraphStyleAttributeName] = ENRMInputParagraphStyleWithLineHeight(_formatterStyle, nil);
  }
  NSMutableAttributedString *text = [[NSMutableAttributedString alloc] initWithString:_placeholderText ?: @""
                                                                           attributes:attrs];
  NSRange fullRange = NSMakeRange(0, text.length);
  CGFloat baselineOffset = calculateBaselineOffset(text, fullRange);
  if (baselineOffset > 0) {
    [text addAttribute:NSBaselineOffsetAttributeName value:@(baselineOffset) range:fullRange];
  }
  ENRMSetPlaceholderAttributedText(_placeholderLabel, text);
}

- (void)updatePlaceholderVisibility
{
  // Hide the placeholder once there's any content OR any block has been started
  // (e.g. an empty bullet/heading line with only a zero-length anchor): the block
  // marker or indent would otherwise overlap the placeholder text.
  BOOL hasText = ENRMGetPlainText(_textView).length > 0;
  BOOL hasBlock = _blockStore.allRanges.count > 0;
  _placeholderLabel.hidden = hasText || hasBlock;
}

#pragma mark - Markdown import

- (void)importMarkdown:(NSString *)markdown
{
  ENRMInputParser *parser = [[ENRMInputParser alloc] init];
  ENRMParseResult *parsed = [parser parseToPlainTextAndRanges:markdown];

  [_editSession enterPhase:ENRMEditPhaseImporting];

  [_editSession enterPhase:ENRMEditPhaseFormatting];
  // UITextView stamps typingAttributes (including list headIndent from the
  // previous cursor) onto all text set via .text. Reset before import so
  // setValue does not indent non-list lines with the old list depth.
  [self resetBaseTypingAttributes];
  ENRMSetPlainText(_textView, parsed.plainText);
  [_editSession enterPhase:ENRMEditPhaseImporting];

  [_formattingStore setRanges:parsed.formattingRanges];
  [_blockStore setRanges:parsed.blockRanges];
  _lastTextLength = parsed.plainText.length;
  _lastSelectedRange = _textView.selectedRange;

  [_editSession exitPhase];
  [self applyFormatting];
  [self updatePlaceholderVisibility];

  if (parsed.plainText.length == 0) {
    [self resetBaseTypingAttributes];
  }
}

- (void)replaceTextInRange:(NSRange)selection
                  withText:(NSString *)text
          formattingRanges:(NSArray<ENRMFormattingRange *> *)ranges
               blockRanges:(NSArray<ENRMBlockRange *> *)blockRanges
{
  NSUInteger editLocation = selection.location;

  [_editSession enterPhase:ENRMEditPhaseFormatting];
  ENRMReplaceTextInRange(_textView, text, selection);
  [_editSession exitPhase];

  NSString *plainText = [self adjustStoresForEditAtLocation:editLocation
                                              deletedLength:selection.length
                                             insertedLength:text.length];

  for (ENRMFormattingRange *range in ranges) {
    NSRange shifted = NSMakeRange(range.range.location + editLocation, range.range.length);
    [_formattingStore addRange:[ENRMFormattingRange rangeWithType:range.type range:shifted url:range.url]];
  }

  for (ENRMBlockRange *block in blockRanges) {
    NSRange shifted = NSMakeRange(block.range.location + editLocation, block.range.length);
    [_blockStore setBlockType:block.type level:block.level forParagraphRange:shifted inText:plainText];
  }

  _lastTextLength = plainText.length;
  _lastSelectedRange = _textView.selectedRange;

  [self applyFormatting];

  [_detectorPipeline processTextChange:plainText modificationRange:NSMakeRange(editLocation, text.length)];

  [self updatePlaceholderVisibility];
  [_inputEventEmitter emitOnChangeText];
  [_inputEventEmitter emitOnChangeSelection];
  [_inputEventEmitter emitFormattingChanged];
  [self requestHeightUpdate];
  [self scheduleRelayoutIfNeeded];
}

- (void)replaceTextInRange:(NSRange)selection
                  withText:(NSString *)text
          formattingRanges:(NSArray<ENRMFormattingRange *> *)ranges
{
  [self replaceTextInRange:selection withText:text formattingRanges:ranges blockRanges:@[]];
}

- (void)replaceSelectedTextWith:(NSString *)text formattingRanges:(NSArray<ENRMFormattingRange *> *)ranges
{
  [self replaceTextInRange:_textView.selectedRange withText:text formattingRanges:ranges];
}

/// Insertion is literal: the string's characters land at the cursor exactly as
/// given. Markdown parsing consumes leading and trailing newlines as block
/// structure, so they are split off before the parse and re-attached verbatim;
/// without this, inserting "\n- item\n" mid-paragraph would merge the list line
/// with the surrounding text. Callers decide separation by including (or
/// omitting) newlines in the string.
- (void)pasteMarkdown:(NSString *)markdown
{
  NSUInteger lead = 0;
  while (lead < markdown.length && [markdown characterAtIndex:lead] == '\n') {
    lead++;
  }
  NSUInteger trail = 0;
  while (lead + trail < markdown.length && [markdown characterAtIndex:markdown.length - 1 - trail] == '\n') {
    trail++;
  }
  NSString *core = [markdown substringWithRange:NSMakeRange(lead, markdown.length - lead - trail)];

  ENRMInputParser *parser = [[ENRMInputParser alloc] init];
  ENRMParseResult *parsed = [parser parseToPlainTextAndRanges:core];

  if (lead == 0 && trail == 0) {
    [self replaceTextInRange:_textView.selectedRange
                    withText:parsed.plainText
            formattingRanges:parsed.formattingRanges
                 blockRanges:parsed.blockRanges];
    return;
  }

  NSString *prefix = [@"" stringByPaddingToLength:lead withString:@"\n" startingAtIndex:0];
  NSString *suffix = [@"" stringByPaddingToLength:trail withString:@"\n" startingAtIndex:0];
  NSString *plainText = [NSString stringWithFormat:@"%@%@%@", prefix, parsed.plainText, suffix];

  NSMutableArray<ENRMFormattingRange *> *formattingRanges =
      [NSMutableArray arrayWithCapacity:parsed.formattingRanges.count];
  for (ENRMFormattingRange *range in parsed.formattingRanges) {
    NSRange shifted = NSMakeRange(range.range.location + lead, range.range.length);
    [formattingRanges addObject:[ENRMFormattingRange rangeWithType:range.type range:shifted url:range.url]];
  }
  NSMutableArray<ENRMBlockRange *> *blockRanges = [NSMutableArray arrayWithCapacity:parsed.blockRanges.count];
  for (ENRMBlockRange *block in parsed.blockRanges) {
    NSRange shifted = NSMakeRange(block.range.location + lead, block.range.length);
    [blockRanges addObject:[ENRMBlockRange rangeWithType:block.type range:shifted level:block.level]];
  }
  [self replaceTextInRange:_textView.selectedRange
                  withText:plainText
          formattingRanges:formattingRanges
               blockRanges:blockRanges];
}

#pragma mark - Formatting

- (void)resetBaseTypingAttributes
{
  NSMutableDictionary *attrs = [@{
    NSFontAttributeName : _formatterStyle.baseFont,
    NSForegroundColorAttributeName : _formatterStyle.baseTextColor,
  } mutableCopy];
  if (_formatterStyle.baseLineHeight > 0) {
    attrs[NSParagraphStyleAttributeName] = ENRMInputParagraphStyleWithLineHeight(_formatterStyle, nil);
  }
  ENRMSetDefaultTypingAttributes(_textView, attrs);
}

- (void)applyFormatting
{
  [self applyFormattingScopedToRange:NSMakeRange(0, ENRMGetPlainText(_textView).length)];
}

/// Per-keystroke variant: re-applies inline and block attributes only on the
/// line(s) touched by the edit, mirroring Android's applyFormattingScopedToEdit.
- (void)applyFormattingScopedToEditAtLocation:(NSUInteger)editLocation insertedLength:(NSUInteger)insertedLength
{
  NSString *plainText = ENRMGetPlainText(_textView);
  NSUInteger textLength = plainText.length;
  if (textLength == 0) {
    [self applyFormatting];
    return;
  }

  NSUInteger rawStart = MIN(editLocation, textLength);
  NSUInteger rawEnd = MIN(editLocation + insertedLength, textLength);
  rawEnd = MAX(rawEnd, rawStart);
  NSRange scope = [plainText lineRangeForRange:NSMakeRange(rawStart, rawEnd - rawStart)];
  [self applyFormattingScopedToRange:scope];
}

/// Newline variant: a newline can only restructure the paragraph it lands in and
/// blocks below it, never content above. Scoping from the edit's paragraph start
/// to the end of the text leaves paragraphs above untouched (issue #739). A
/// backspace-merge is covered because editLocation lands at the merge point,
/// whose paragraph range extends back over the joined previous line.
- (void)applyFormattingScopedFromParagraphAtLocation:(NSUInteger)editLocation
{
  NSString *plainText = ENRMGetPlainText(_textView);
  NSUInteger textLength = plainText.length;
  if (textLength == 0) {
    [self applyFormatting];
    return;
  }

  NSUInteger location = MIN(editLocation, textLength);
  NSRange paragraph = [plainText paragraphRangeForRange:NSMakeRange(location, 0)];
  NSRange scope = NSMakeRange(paragraph.location, textLength - paragraph.location);
  [self applyFormattingScopedToRange:scope];
}

- (void)applyFormattingScopedToRange:(NSRange)scope
{
  if (_editSession.shouldSuppressFormatting) {
    return;
  }
  if (_editSession.isComposing) {
    return;
  }
  [_editSession enterPhase:ENRMEditPhaseFormatting];

  NSRange savedSelection = _textView.selectedRange;

  [_formatter applyFormattingRanges:_formattingStore.allRanges
                         toTextView:_textView
                              style:_formatterStyle
                      scopedToRange:scope];
  [_formatter applyBlockRanges:_blockStore.allRanges toTextView:_textView style:_formatterStyle scopedToRange:scope];
  [_detectorPipeline refreshAllStyling];
  [self applyWritingDirection];

  NSUInteger textLen = ENRMGetPlainText(_textView).length;
  if (savedSelection.location + savedSelection.length <= textLen) {
    _textView.selectedRange = savedSelection;
  }

  [_editSession exitPhase];
}

- (void)applyWritingDirection
{
  NSTextStorage *textStorage = _textView.textStorage;
  if (textStorage.length == 0) {
    return;
  }
  [textStorage beginEditing];
  ENRMApplyWritingDirectionMode(textStorage, _writingDirectionMode, _resolvedLayoutDirection);
  [textStorage endEditing];
}

#pragma mark - Commands

- (void)focus
{
  ENRMFocusTextView(_textView);
}

- (void)blur
{
  ENRMBlurTextView(_textView);
}

- (void)setValue:(NSString *)markdown
{
  [self importMarkdown:markdown];
  _lastSelectedRange = _textView.selectedRange;
  [_inputEventEmitter emitOnChangeText];
  [_inputEventEmitter emitOnChangeSelection];
  [_inputEventEmitter emitOnChangeState];
  [self requestHeightUpdate];
}

- (void)setSelection:(NSInteger)start end:(NSInteger)end
{
  NSInteger textLen = (NSInteger)ENRMGetPlainText(_textView).length;
  NSInteger clampedStart = MIN(MAX(start, 0), textLen);
  NSInteger clampedEnd = MIN(MAX(end, clampedStart), textLen);
  _textView.selectedRange = NSMakeRange((NSUInteger)clampedStart, (NSUInteger)(clampedEnd - clampedStart));
  [_inputEventEmitter emitOnChangeSelection];
  [_inputEventEmitter emitOnChangeState];
}

- (void)toggleBold
{
  [self toggleInlineStyle:ENRMInputStyleTypeStrong];
}

- (void)toggleItalic
{
  [self toggleInlineStyle:ENRMInputStyleTypeEmphasis];
}

- (void)toggleUnderline
{
  [self toggleInlineStyle:ENRMInputStyleTypeUnderline];
}

- (void)toggleStrikethrough
{
  [self toggleInlineStyle:ENRMInputStyleTypeStrikethrough];
}

- (void)toggleSpoiler
{
  [self toggleInlineStyle:ENRMInputStyleTypeSpoiler];
}

- (void)toggleInlineStyle:(ENRMInputStyleType)styleType
{
  id<ENRMStyleHandler> handler = [_formatter handlerForStyleType:styleType];
  if (!handler) {
    return;
  }
  ENRMStyleMergingConfig *mergingConfig = handler.mergingConfig;

  NSRange selection = _textView.selectedRange;

  if ([_formattingStore isToggleBlocked:styleType
                             atPosition:selection.location
                         blockingStyles:mergingConfig.blockingStyles]) {
    return;
  }

  BOOL wasActive = [_formattingStore toggleStyle:styleType
                                         inRange:selection
                               conflictingStyles:mergingConfig.conflictingStyles];

  [_typingController togglePendingStyle:styleType wasActive:wasActive hasSelection:(selection.length > 0)];

  [self applyFormatting];
  [_typingController syncWithPendingStyles];
  [_inputEventEmitter emitFormattingChanged];
}

- (void)toggleHeading:(NSInteger)level
{
  if (level < 1 || level > 6) {
    return;
  }
  [self toggleBlockType:ENRMBlockTypeForHeadingLevel(level) level:level];
}

- (void)toggleBlockType:(ENRMInputBlockType)type level:(NSInteger)level
{
  NSString *text = ENRMGetPlainText(_textView);
  BOOL alreadyActive = [_blockCoordinator toggleBlockType:type
                                                    level:level
                                           selectionRange:_textView.selectedRange
                                                   inText:text];

  if (alreadyActive) {
    // Strip the stored block paragraph style directly: an empty item's line has no
    // stamped block-marker attribute (zero-length ranges are never stamped), so the
    // applyFormatting reset below — which is keyed off that marker — cannot reach it.
    NSRange paragraphRange = [text paragraphRangeForRange:_textView.selectedRange];
    NSTextStorage *storage = _textView.textStorage;
    NSRange clamped = NSIntersectionRange(paragraphRange, NSMakeRange(0, storage.length));
    if (clamped.length > 0) {
      [storage beginEditing];
      [storage removeAttribute:NSParagraphStyleAttributeName range:clamped];
      [storage endEditing];
    }
  }

  [self applyFormatting];
  [_typingController syncWithCursorBlock];
  [self updatePlaceholderVisibility];
  if (alreadyActive) {
    [_typingController clearListParagraphStyle];
  }
  [self updateEmptyBulletMarker];
  [_inputEventEmitter emitFormattingChanged];
}

- (void)toggleUnorderedList
{
  [self toggleBlockType:ENRMInputBlockTypeUnorderedListItem level:0];
}

- (void)toggleOrderedList
{
  [self toggleBlockType:ENRMInputBlockTypeOrderedListItem level:0];
}

- (void)indentList
{
  [self changeListDepthBy:1];
}

- (void)outdentList
{
  [self changeListDepthBy:-1];
}

- (void)changeListDepthBy:(NSInteger)delta
{
  NSString *text = ENRMGetPlainText(_textView);
  ENRMDepthChangeResult result = [_blockCoordinator changeDepthBy:delta
                                                   cursorPosition:_textView.selectedRange.location
                                                   selectionRange:_textView.selectedRange
                                                           inText:text];
  if (result == ENRMDepthChangeResultNoOp) {
    return;
  }
  [self applyFormatting];
  [_typingController syncWithCursorBlock];
  [self updateEmptyBulletMarker];
  [_inputEventEmitter emitFormattingChanged];
}

- (nullable ENRMBlockRange *)listBlockForCursorParagraph
{
  return [self listBlockForParagraphAtPosition:_textView.selectedRange.location];
}

- (nullable ENRMBlockRange *)listBlockForParagraphAtPosition:(NSUInteger)position
{
  return [_blockCoordinator listBlockAtPosition:position inText:_textView.textStorage.string];
}

- (nullable ENRMBlockRange *)blockForParagraphAtPosition:(NSUInteger)position
{
  return [_blockCoordinator blockAtPosition:position inText:_textView.textStorage.string];
}

- (BOOL)listStateOfType:(ENRMInputBlockType)type forCursorParagraphDepth:(nullable NSInteger *)outDepth
{
  return [_blockCoordinator listStateOfType:type
                                 atPosition:_textView.selectedRange.location
                                     inText:_textView.textStorage.string
                                      depth:outDepth];
}

/// Records the block kind/level of the line being edited before the change, so a
/// Return that continues a list can recover the previous item's depth and an
/// in-line replacement (autocorrect/paste) that wipes the line can heal it.
- (void)capturePreEditBlockForRange:(NSRange)range
{
  ENRMBlockRange *block = [self blockForParagraphAtPosition:range.location];
  _preEditBlockType = block != nil ? block.type : ENRMInputBlockTypeParagraph;
  _preEditBlockLevel = block != nil ? block.level : 0;
}

/// Whether `range` of the current (pre-edit) text contains a line break. Scans
/// only the replaced run, mirroring Android's editTouchedNewline.
- (BOOL)replacedRangeTouchesNewline:(NSRange)range
{
  NSString *text = _textView.textStorage.string;
  if (range.length == 0 || range.location >= text.length) {
    return NO;
  }
  NSRange clamped = NSMakeRange(range.location, MIN(range.length, text.length - range.location));
  return [text rangeOfCharacterFromSet:[NSCharacterSet newlineCharacterSet] options:0 range:clamped].location !=
         NSNotFound;
}

/// Whether the caret's paragraph had no glyph content at the start of the edit
/// (an empty line). Used to decide whether Return continues or exits the list.
- (BOOL)preEditParagraphWasEmpty:(NSRange)range
{
  NSString *text = _textView.textStorage.string;
  if (text.length == 0) {
    return YES;
  }
  NSRange paragraph = [text paragraphRangeForRange:range];
  if (paragraph.length == 0) {
    return YES;
  }
  return [[text substringWithRange:paragraph] isEqualToString:@"\n"];
}

/// Intercepts Tab (indent) and Backspace at a bullet item's start (outdent, then
/// un-list at depth 0). Returns YES when handled, suppressing the default edit.
/// Keyed off the caret's own paragraph (NSMaxRange(range)), not range.location —
/// a backspace at a line start targets the previous line's newline, and using the
/// caret's line lets the next Backspace after un-listing fall through to a merge.
- (BOOL)handleListKeyForReplacementRange:(NSRange)range replacementText:(NSString *)text
{
  NSUInteger caret = NSMaxRange(range);
  NSInteger depth;
  if (![self listStateForParagraphAtPosition:caret depth:&depth]) {
    return NO;
  }

  // Tab indents the current item.
  if ([text isEqualToString:@"\t"]) {
    [self indentList];
    return YES;
  }

  // Backspace at the very start of the caret's own item: outdent, or remove the
  // marker entirely once at depth 0 (de-indenting the line to a plain paragraph).
  if (text.length == 0 && range.length == 1) {
    NSString *plainText = ENRMGetPlainText(_textView);
    NSRange paragraphRange = [plainText paragraphRangeForRange:NSMakeRange(caret, 0)];
    BOOL atItemStart = caret == paragraphRange.location;
    if (atItemStart) {
      if (depth > 0) {
        [self outdentList];
      } else {
        ENRMBlockRange *listBlock = [self listBlockForParagraphAtPosition:caret];
        [self toggleBlockType:listBlock != nil ? listBlock.type : ENRMInputBlockTypeUnorderedListItem level:0];
      }
      return YES;
    }
  }

  return NO;
}

/// Backspace at the document start (caret at 0) never fires the text-change
/// delegate — nothing precedes the caret — so the first line's bullet has to be
/// outdented/removed here. Returns YES when handled.
- (BOOL)handleBackspaceAtDocumentStart
{
  NSRange selection = _textView.selectedRange;
  if (selection.location != 0 || selection.length != 0) {
    return NO;
  }
  ENRMBlockRange *listBlock = [self listBlockForCursorParagraph];
  if (listBlock == nil) {
    return NO;
  }
  if (listBlock.level > 0) {
    [self outdentList];
  } else {
    [self toggleBlockType:listBlock.type level:0];
  }
  return YES;
}

- (BOOL)listStateForParagraphAtPosition:(NSUInteger)position depth:(NSInteger *)outDepth
{
  ENRMBlockRange *block = [_blockCoordinator listBlockAtPosition:position inText:_textView.textStorage.string];
  if (block != nil) {
    if (outDepth) {
      *outDepth = block.level;
    }
    return YES;
  }
  return NO;
}

/// Drives the layout manager's empty-line bullet: an empty bullet line has no
/// character to anchor the marker to, so the manager is told its location/depth
/// explicitly; cleared when the caret isn't on an empty bullet line. Runs on
/// every selection-change fire, so it early-returns when there is nothing to
/// draw or clear and only touches storage when the paragraph style differs,
/// avoiding layout churn that jitters the edit menu.
- (void)updateEmptyBulletMarker
{
  NSString *text = ENRMGetPlainText(_textView);
  NSRange selection = _textView.selectedRange;
  BOOL show = NO;
  NSUInteger location = 0;
  NSInteger depth = 0;

  BOOL ordered = NO;
  NSInteger ordinal = 1;
  ENRMBlockRange *cursorListBlock = selection.length == 0 ? [self listBlockForCursorParagraph] : nil;

  ENRMInputListMarkerDrawer *listDrawer = _layoutManager.listMarkerDrawer;
  BOOL wasShown = listDrawer.emptyBulletDepth >= 0;
  if (cursorListBlock == nil && !wasShown) {
    return;
  }

  if (cursorListBlock != nil) {
    NSInteger cursorDepth = cursorListBlock.level;
    ordered = cursorListBlock.type == ENRMInputBlockTypeOrderedListItem;
    ordinal = cursorListBlock.ordinal;
    NSRange paragraphRange = text.length == 0 ? NSMakeRange(0, 0) : [text paragraphRangeForRange:selection];
    NSString *paragraphText = text.length == 0 ? @"" : [text substringWithRange:paragraphRange];
    BOOL empty = paragraphText.length == 0 || [paragraphText isEqualToString:@"\n"];
    if (empty) {
      show = YES;
      location = paragraphRange.location;
      depth = cursorDepth;

      // A mid-document empty bullet line has no paragraph style and lays out
      // flush left; stamp the list style so caret and marker indent immediately.
      // (A trailing empty line uses the extra line fragment instead.)
      if (paragraphRange.length > 0) {
        CGFloat indent = (depth + 1) * kENRMListIndentPerDepth;
        NSTextStorage *storage = _textView.textStorage;
        NSParagraphStyle *existing = [storage attribute:NSParagraphStyleAttributeName
                                                atIndex:paragraphRange.location
                                         effectiveRange:NULL];
        if (existing == nil || existing.firstLineHeadIndent != indent || existing.headIndent != indent ||
            existing.paragraphSpacingBefore != _formatterStyle.listItemSpacing) {
          NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
          paragraph.firstLineHeadIndent = indent;
          paragraph.headIndent = indent;
          paragraph.paragraphSpacingBefore = _formatterStyle.listItemSpacing;
          [storage beginEditing];
          [storage addAttribute:NSParagraphStyleAttributeName value:paragraph range:paragraphRange];
          [storage endEditing];
        }
      }
    }
  }

  if (!show && !wasShown) {
    return;
  }

  listDrawer.emptyBulletDepth = show ? depth : -1;
  listDrawer.emptyBulletOrdered = ordered;
  listDrawer.emptyBulletOrdinal = ordinal;
  listDrawer.emptyBulletLocation = location;
  listDrawer.emptyBulletFont = _formatterStyle.baseFont;
  listDrawer.emptyBulletColor = _formatterStyle.baseTextColor;
  listDrawer.emptyBulletRTL = [self emptyListLineIsRTL];
  listDrawer.listItemSpacing = _formatterStyle.listItemSpacing;

  BOOL isTrailing = show && text.length > 0 && location >= text.length;

  // Ensure the extra line fragment is laid out so we can read
  // extraLineFragmentTextContainer / extraLineFragmentUsedRect.  The
  // empty-editor case (length 0) has no glyphs at all; the trailing-line case
  // (location >= length) has glyphs on preceding lines but the extra line
  // fragment lives beyond them and isn't covered by ensureLayoutForCharRange:.
  if (show && (text.length == 0 || location >= text.length)) {
    [_layoutManager ensureLayoutForTextContainer:_textView.textContainer];
  }

#if !TARGET_OS_OSX
  if (isTrailing && _layoutManager.extraLineFragmentTextContainer != nil) {
    [listDrawer showTrailingBulletInTextView:_textView
                               textContainer:_layoutManager.extraLineFragmentTextContainer
                                    usedRect:_layoutManager.extraLineFragmentUsedRect];
  } else {
    [listDrawer hideTrailingBullet];
  }
#endif

  ENRMSetNeedsDisplay(_textView);

  // The empty-editor bullet would otherwise overlap the placeholder.
  [self updatePlaceholderVisibility];
}

/// Writing direction the empty list line resolves to, for mirroring its marker.
/// An empty line has no strong character, so Auto and FirstStrong fall back the
/// same way the formatter's direction pass would.
- (BOOL)emptyListLineIsRTL
{
  switch (_writingDirectionMode) {
    case ENRMWritingDirectionModeLTR:
      return NO;
    case ENRMWritingDirectionModeRTL:
      return YES;
    case ENRMWritingDirectionModeFirstStrong:
      return _resolvedLayoutDirection == NSWritingDirectionRightToLeft;
    case ENRMWritingDirectionModeAuto:
    default:
      return ENRMParagraphIsRTL(nil);
  }
}

- (NSInteger)headingLevelForCursorParagraph
{
  return [_blockCoordinator headingLevelAtPosition:_textView.selectedRange.location
                                            inText:_textView.textStorage.string];
}

- (NSString *)adjustStoresForEditAtLocation:(NSUInteger)editLocation
                              deletedLength:(NSUInteger)deletedLength
                             insertedLength:(NSUInteger)insertedLength
{
  return [_editPipeline adjustStoresForEditAtLocation:editLocation
                                        deletedLength:deletedLength
                                       insertedLength:insertedLength];
}

- (void)setLink:(NSString *)url
{
  NSRange selection = _textView.selectedRange;
  if (![_linkCoordinator setLinkURL:url forSelection:selection]) {
    return;
  }
  [self applyFormatting];
  [_inputEventEmitter emitFormattingChanged];
}

- (void)insertLink:(NSString *)text url:(NSString *)url
{
  NSString *displayText = text.length > 0 ? text : url;
  NSRange linkRange = NSMakeRange(0, displayText.length);
  ENRMFormattingRange *range = [ENRMFormattingRange rangeWithType:ENRMInputStyleTypeLink
                                                            range:linkRange
                                                              url:[_linkCoordinator sanitizeURL:url]];
  [self replaceSelectedTextWith:displayText formattingRanges:@[ range ]];
}

- (void)insertText:(NSString *)text
{
  if (text.length == 0) {
    return;
  }
  [self pasteMarkdown:text];
}

- (void)startMention:(NSString *)indicator
{
  if (indicator.length == 0 || ![_mentionCoordinator containsIndicator:indicator]) {
    return;
  }

  [self replaceSelectedTextWith:indicator formattingRanges:@[]];
  [self dispatchMentionUpdate];
}

- (void)insertMention:(NSString *)displayText url:(NSString *)url
{
  if (displayText.length == 0 || !_mentionCoordinator.isActive ||
      _mentionCoordinator.activeRange.location == NSNotFound) {
    return;
  }

  NSString *plainText = ENRMGetPlainText(_textView);
  NSRange activeRange = _mentionCoordinator.activeRange;
  NSUInteger rangeEnd = NSMaxRange(activeRange);
  if (rangeEnd > plainText.length) {
    return;
  }
  BOOL nextCharIsWhitespace = rangeEnd < plainText.length && [[NSCharacterSet whitespaceAndNewlineCharacterSet]
                                                                 characterIsMember:[plainText
                                                                                       characterAtIndex:rangeEnd]];
  NSString *replacement = nextCharIsWhitespace ? displayText : [displayText stringByAppendingString:@" "];
  ENRMFormattingRange *linkRange = [ENRMFormattingRange rangeWithType:ENRMInputStyleTypeLink
                                                                range:NSMakeRange(0, displayText.length)
                                                                  url:[_linkCoordinator sanitizeURL:url]];
  NSString *indicator = _mentionCoordinator.activeIndicator;

  [self dispatchMentionEvents:[_mentionCoordinator clearWithIndicatorOverride:indicator]];
  [self replaceTextInRange:activeRange withText:replacement formattingRanges:@[ linkRange ]];
  _textView.selectedRange = NSMakeRange(activeRange.location + replacement.length, 0);
  [_inputEventEmitter emitOnChangeSelection];
}

- (void)removeLink
{
  if (![_linkCoordinator removeLinkForSelection:_textView.selectedRange]) {
    return;
  }
  [self applyFormatting];
  [_inputEventEmitter emitFormattingChanged];
}

- (void)showLinkPrompt
{
  ENRMFormattingRange *activeLink = [_linkCoordinator linkForSelection:_textView.selectedRange];
  NSString *existingURL = activeLink != nil ? activeLink.url : nil;

  __weak EnrichedMarkdownTextInput *weakSelf = self;
  ENRMShowLinkPrompt(self, existingURL, ^(NSString *url) { [weakSelf setLink:url]; });
}

/// Serializes plain text with inline + block formatting, resolving each block's
/// markdown line prefix through its registered handler. With no block handlers
/// registered the prefix provider is never consulted productively and output
/// equals the inline-only serialization.
- (NSString *)serializeText:(NSString *)text
                     ranges:(NSArray<ENRMFormattingRange *> *)ranges
                blockRanges:(NSArray<ENRMBlockRange *> *)blockRanges
{
  return [_clipboardCoordinator serializeText:text ranges:ranges blockRanges:blockRanges];
}

- (nullable NSString *)markdownForSelectedRange
{
  return [_clipboardCoordinator serializeSelectedRange:_textView.selectedRange inText:ENRMGetPlainText(_textView)];
}

- (void)copyToClipboard
{
  NSString *plainText = ENRMGetPlainText(_textView);
  if (plainText.length == 0) {
    return;
  }
  NSString *markdown = [_clipboardCoordinator serializeFullDocument:plainText];
  NSMutableDictionary *items = [NSMutableDictionary dictionary];
  items[kUTIPlainText] = plainText;
  if (markdown.length > 0) {
    items[kENRMMarkdownPasteboardType] = markdown;
  }
  copyItemsToPasteboard(items);
}

- (void)requestMarkdown:(NSInteger)requestId
{
  [_inputEventEmitter requestMarkdown:requestId];
}

- (CGRect)computeCaretRect
{
  CGRect caretRect = CGRectZero;
#if !TARGET_OS_OSX
  UITextRange *selectedRange = _textView.selectedTextRange;
  if (selectedRange != nil) {
    caretRect = [_textView caretRectForPosition:selectedRange.start];
  }
#else
  NSRange selection = _textView.selectedRange;
  if (selection.location != NSNotFound) {
    NSRange glyphRange = [_textView.layoutManager glyphRangeForCharacterRange:NSMakeRange(selection.location, 0)
                                                         actualCharacterRange:NULL];
    caretRect = [_textView.layoutManager boundingRectForGlyphRange:glyphRange inTextContainer:_textView.textContainer];
    caretRect.origin.x += _textView.textContainerInset.left;
    caretRect.origin.y += _textView.textContainerInset.top;
  }
#endif
  return caretRect;
}

- (void)requestCaretRect:(NSInteger)requestId
{
  [_inputEventEmitter requestCaretRect:requestId];
}

- (void)handleCommand:(const NSString *)commandName args:(const NSArray *)args
{
  RCTEnrichedMarkdownTextInputHandleCommand(self, commandName, args);
}

#pragma mark - ENRMInputEventEmitterDataSource

- (std::shared_ptr<EnrichedMarkdownTextInputEventEmitter const>)fabricEventEmitter
{
  if (_eventEmitter == nullptr || _editSession.shouldSuppressEvents) {
    return nullptr;
  }
  return std::static_pointer_cast<EnrichedMarkdownTextInputEventEmitter const>(_eventEmitter);
}

- (NSRange)selectedRange
{
  return _textView.selectedRange;
}

- (BOOL)isStyleActive:(ENRMInputStyleType)type inRange:(NSRange)range
{
  return [_formattingStore isStyleActive:type inRange:range];
}

- (BOOL)isEffectiveStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position
{
  return [_typingController isEffectiveStyleActive:type atPosition:position];
}

- (nullable ENRMFormattingRange *)linkForSelection:(NSRange)selection
{
  return [_linkCoordinator linkForSelection:selection];
}

#pragma mark - ENRMInputTypingAttributesDataSource

- (BOOL)isStyleAdjacentBefore:(ENRMInputStyleType)type position:(NSUInteger)position
{
  return [_formattingStore isStyleAdjacentBefore:type position:position];
}

- (BOOL)isStyleActive:(ENRMInputStyleType)type atPosition:(NSUInteger)position
{
  return [_formattingStore isStyleActive:type atPosition:position];
}

- (NSString *)currentMarkdown
{
  return [self serializeText:ENRMGetPlainText(_textView)
                      ranges:[self allRangesIncludingTransient]
                 blockRanges:_blockStore.allRanges];
}

- (NSArray<ENRMFormattingRange *> *)allRangesIncludingTransient
{
  return [_clipboardCoordinator allRangesIncludingTransient];
}

- (void)updateActiveMention
{
  [self dispatchMentionUpdate];
}

- (void)clearActiveMention:(nullable NSString *)indicatorOverride
{
  [self dispatchMentionEvents:[_mentionCoordinator clearWithIndicatorOverride:indicatorOverride]];
}

- (void)dispatchMentionUpdate
{
  NSString *plainText = ENRMGetPlainText(_textView);
  [self dispatchMentionEvents:[_mentionCoordinator updateWithText:plainText selectedRange:_textView.selectedRange]];
}

- (void)dispatchMentionEvents:(NSArray<ENRMMentionEvent *> *)events
{
  for (ENRMMentionEvent *event in events) {
    switch (event.type) {
      case ENRMMentionEventStart:
        [_inputEventEmitter emitOnStartMention:event.indicator];
        break;
      case ENRMMentionEventChange:
        [_inputEventEmitter emitOnChangeMentionWithIndicator:event.indicator text:event.text];
        break;
      case ENRMMentionEventEnd:
        [_inputEventEmitter emitOnEndMention:event.indicator];
        break;
    }
  }
}

/// Handles backspace or delete on a link's text, or deleting a selection that
/// starts in a link. Without this, UIKit removes only those characters and
/// leaves a partial link still pointing at the old URL; with it, the whole link
/// is deleted. Returns YES when it did so, and the caller rejects UIKit's edit.
- (BOOL)deleteLinkForReplacementRange:(NSRange)range replacementText:(NSString *)text
{
  if (text.length > 0) {
    return NO;
  }

  // linkForSelection: would match a caret at a link's start, so backspace at
  // the start of the text would delete a link that follows it.
  ENRMFormattingRange *linkRange = range.length > 0 ? [_linkCoordinator linkForSelection:range]
                                                    : [_linkCoordinator linkRangeForDeletionAtPosition:range.location];
  if (linkRange == nil) {
    return NO;
  }

  [self replaceTextInRange:linkRange.range withText:@"" formattingRanges:@[]];
  [self clearActiveMention:nil];
  return YES;
}

- (NSArray<NSString *> *)contextMenuItemTexts
{
  return _contextMenuItemTexts ?: @[];
}

- (NSArray<NSString *> *)contextMenuItemIcons
{
  return _contextMenuItemIcons ?: @[];
}

- (ENRMInputSelectionMenuConfig)inputSelectionMenuConfig
{
  return _inputSelectionMenuConfig;
}

- (ENRMFormatMenuConfig)formatMenuConfig
{
  return _formatMenuConfig;
}

- (ENRMInputEventEmitter *)inputEventEmitter
{
  return _inputEventEmitter;
}

- (ENRMInputTypingAttributesController *)typingController
{
  return _typingController;
}

#pragma mark - Text edit tracking

/// Markdown shortcuts: when the user types a space after `#`…`######`,
/// `-`/`*`/`+` or `1.`/`1)` at the start of a plain paragraph, drop the prefix
/// and make the paragraph that block. Runs after the stores are adjusted for the
/// edit and before scoped formatting. Returns YES when it converted, in which
/// case the replace path has already reformatted and emitted.
- (BOOL)applyMarkdownShortcutForEditAtLocation:(NSUInteger)editLocation
                                 deletedLength:(NSUInteger)deletedLength
                                insertedLength:(NSUInteger)insertedLength
{
  // A typing affordance, not a paste/import path: pure insertions only, which
  // is also how block continuation gates itself.
  if (!ENRMMarkdownShortcutsEnabled(_markdownShortcutsConfig) || deletedLength != 0 || insertedLength == 0) {
    return NO;
  }

  NSString *text = ENRMGetPlainText(_textView);
  if (editLocation >= text.length) {
    return NO;
  }
  NSUInteger insertedEnd = MIN(editLocation + insertedLength, text.length);

  // The trigger is the first space inside the inserted run — a single
  // keystroke in the common case, a whole token when an automation inserts
  // several characters at once. A line break ends the search so the converted
  // line is always the one the insertion started on.
  NSCharacterSet *newlines = [NSCharacterSet newlineCharacterSet];
  NSUInteger spaceIndex = NSNotFound;
  for (NSUInteger i = editLocation; i < insertedEnd; i++) {
    unichar c = [text characterAtIndex:i];
    if (c == ' ') {
      spaceIndex = i;
      break;
    }
    if ([newlines characterIsMember:c]) {
      return NO;
    }
  }
  if (spaceIndex == NSNotFound) {
    return NO;
  }

  NSUInteger lineStart = [text paragraphRangeForRange:NSMakeRange(spaceIndex, 0)].location;
  if (spaceIndex == lineStart || [_blockCoordinator blockAtPosition:lineStart inText:text] != nil) {
    return NO;
  }

  NSString *prefix = [text substringWithRange:NSMakeRange(lineStart, spaceIndex - lineStart)];
  ENRMInputBlockType type = ENRMInputBlockTypeParagraph;
  NSInteger level = 0;
  if (![ENRMMarkdownShortcutMatcher matchPrefix:prefix config:_markdownShortcutsConfig outType:&type outLevel:&level]) {
    return NO;
  }

  NSRange prefixRange = NSMakeRange(lineStart, spaceIndex + 1 - lineStart);
  NSRange caretBefore = _textView.selectedRange;

  // A zero-length range at the line start: the store expands it to the whole
  // paragraph, and on an emptied line it persists as the block's anchor.
  ENRMBlockRange *block = [ENRMBlockRange rangeWithType:type range:NSMakeRange(0, 0) level:level];
  [self replaceTextInRange:prefixRange withText:@"" formattingRanges:@[] blockRanges:@[ block ]];

  if (caretBefore.location >= NSMaxRange(prefixRange)) {
    NSUInteger caret = caretBefore.location - prefixRange.length;
    _textView.selectedRange = NSMakeRange(MIN(caret, ENRMGetPlainText(_textView).length), 0);
  }
  _lastSelectedRange = _textView.selectedRange;

  [_typingController syncWithCursorBlock];
  [self updateEmptyBulletMarker];
  return YES;
}

- (void)handleTextChanged
{
  if (_editSession.isComposing) {
    return;
  }

  NSUInteger newLength = ENRMGetPlainText(_textView).length;
  NSRange selection = _textView.selectedRange;

  NSRange preEditSelection = _preEditSelectedRange;
  NSUInteger editLocation = preEditSelection.location;
  NSUInteger deletedLength = 0;
  NSUInteger insertedLength = 0;

  if (newLength >= _lastTextLength) {
    NSUInteger netInserted = newLength - _lastTextLength;
    deletedLength = preEditSelection.length;
    insertedLength = deletedLength + netInserted;
  } else {
    NSUInteger netDeleted = _lastTextLength - newLength;
    if (preEditSelection.length > 0) {
      deletedLength = preEditSelection.length;
      insertedLength = deletedLength > netDeleted ? deletedLength - netDeleted : 0;
    } else {
      deletedLength = netDeleted;
      insertedLength = 0;
      if (selection.location < editLocation) {
        editLocation = selection.location;
      }
    }
  }

  ENRMEditContext *context = [[ENRMEditContext alloc] initWithEditLocation:editLocation
                                                             deletedLength:deletedLength
                                                            insertedLength:insertedLength
                                                    preEditReplacedNewline:_preEditReplacedNewline
                                                          preEditBlockType:_preEditBlockType
                                                         preEditBlockLevel:_preEditBlockLevel
                                                  preEditParagraphWasEmpty:_preEditParagraphWasEmpty
                                                             pendingStyles:_typingController.pendingStyles
                                                      pendingStyleRemovals:_typingController.pendingStyleRemovals];

  BOOL touchedNewline = [_editPipeline processTextChangeWithContext:context];

  // Consumed: clear pre-edit state so stale values can't leak to the next edit.
  _preEditBlockType = ENRMInputBlockTypeParagraph;
  _preEditBlockLevel = 0;
  _preEditParagraphWasEmpty = NO;
  _preEditReplacedNewline = NO;

  _lastTextLength = newLength;

  // A typed markdown prefix turns the paragraph into a block; the replace path
  // reformats and emits on its own, so the rest of this pass is redundant.
  if ([self applyMarkdownShortcutForEditAtLocation:editLocation
                                     deletedLength:deletedLength
                                    insertedLength:insertedLength]) {
    return;
  }

#if !TARGET_OS_OSX
  if (newLength == 0) {
    if ([self headingLevelForCursorParagraph] > 0 || [self listBlockForCursorParagraph] != nil) {
      [_typingController syncWithCursorBlock];
    } else {
      [self resetBaseTypingAttributes];
    }
  }
#endif

  if (touchedNewline) {
    [self applyFormattingScopedFromParagraphAtLocation:editLocation];
  } else {
    [self applyFormattingScopedToEditAtLocation:editLocation insertedLength:insertedLength];
  }

  if (_textView.selectedRange.length == 0) {
    [_typingController syncWithCursorBlock];
  }

  if ([self listBlockForCursorParagraph] != nil) {
    [_typingController syncWithCursorBlock];
  } else if (_textView.typingAttributes[NSParagraphStyleAttributeName] != nil) {
    [_typingController clearListParagraphStyle];
  }

  [_editPipeline detectLinksAtLocation:editLocation insertedLength:insertedLength];

  [self updatePlaceholderVisibility];
  [_inputEventEmitter emitOnChangeText];
  [_inputEventEmitter emitOnChangeSelection];
  [_inputEventEmitter emitFormattingChanged];
  [self updateActiveMention];
  [_inputEventEmitter emitCaretRectChangeIfNeeded];
  [self requestHeightUpdate];
  [self scheduleRelayoutIfNeeded];
  [self updateEmptyBulletMarker];
}

#pragma mark - Text view delegate

#if !TARGET_OS_OSX

- (void)stripLinkTypingAttributes
{
  NSMutableDictionary *attrs = [_textView.typingAttributes mutableCopy];
  BOOL changed = NO;

  UIColor *linkColor = _formatterStyle.linkColor;
  UIColor *currentColor = attrs[NSForegroundColorAttributeName];
  if (currentColor != nil && linkColor != nil && [currentColor isEqual:linkColor]) {
    attrs[NSForegroundColorAttributeName] = _formatterStyle.baseTextColor;
    changed = YES;
  }

  if (attrs[NSUnderlineStyleAttributeName] != nil) {
    [attrs removeObjectForKey:NSUnderlineStyleAttributeName];
    changed = YES;
  }

  if (attrs[NSLinkAttributeName] != nil) {
    [attrs removeObjectForKey:NSLinkAttributeName];
    changed = YES;
  }

  if (changed) {
    _textView.typingAttributes = attrs;
  }
}

- (void)manageSelectionBasedChanges
{
  [self stripLinkTypingAttributes];

  if (_textView.selectedRange.length == 0 && _editSession.phase == ENRMEditPhaseIdle) {
    NSString *text = ENRMGetPlainText(_textView);
    if (text.length > 0) {
      NSRange paragraphRange = [text paragraphRangeForRange:_textView.selectedRange];
      NSString *paragraphText = [text substringWithRange:paragraphRange];
      BOOL isEmpty = paragraphText.length == 0 || [paragraphText isEqualToString:@"\n"];
      if (isEmpty) {
        if ([self headingLevelForCursorParagraph] > 0 || [self listBlockForCursorParagraph] != nil) {
          [_typingController syncWithCursorBlock];
        } else {
          NSMutableDictionary *attrs = [NSMutableDictionary dictionary];
          attrs[NSFontAttributeName] = _formatterStyle.baseFont;
          attrs[NSForegroundColorAttributeName] = _formatterStyle.baseTextColor;
          _textView.typingAttributes = attrs;
        }
      }
    }
  }
}

- (BOOL)textView:(UITextView *)textView shouldChangeTextInRange:(NSRange)range replacementText:(NSString *)text
{
  [_inputEventEmitter emitOnKeyPress:text];
  if ([self deleteLinkForReplacementRange:range replacementText:text]) {
    return NO;
  }
  if ([self handleListKeyForReplacementRange:range replacementText:text]) {
    return NO;
  }
  _preEditSelectedRange = _lastSelectedRange;
  [self capturePreEditBlockForRange:range];
  _preEditParagraphWasEmpty = [self preEditParagraphWasEmpty:range];
  _preEditReplacedNewline = [self replacedRangeTouchesNewline:range];
  [_editSession enterPhase:ENRMEditPhaseProcessing];
  [self stripLinkTypingAttributes];
  return YES;
}

- (void)textViewDidChange:(UITextView *)textView
{
  if (_editSession.shouldSuppressFormatting) {
    return;
  }
  [self handleTextChanged];
  [_editSession exitPhase];
  [_editSession recordTextChange];
  _lastSelectedRange = textView.selectedRange;
}

- (void)textViewDidBeginEditing:(UITextView *)textView
{
  [_inputEventEmitter emitOnFocus];
}

- (void)textViewDidEndEditing:(UITextView *)textView
{
  [self clearActiveMention:nil];
  [_inputEventEmitter emitOnBlur];
}

/// Atomic-link snap clamped to the current text length, so a stale link range
/// past the text end can't drive an unbounded snap/clamp loop.
- (NSRange)clampedAtomicSelectionForSelection:(NSRange)selection
{
  NSRange adjusted = [_formattingStore selectionAdjustedForAtomicLinks:selection];
  NSUInteger textLength = _textView.textStorage.length;
  if (adjusted.location > textLength) {
    return NSMakeRange(textLength, 0);
  }
  if (NSMaxRange(adjusted) > textLength) {
    adjusted.length = textLength - adjusted.location;
  }
  return adjusted;
}

/// YES while a UIKit selection gesture (handle drag, long-press loupe) is
/// mid-flight; snapping selectedRange then fights the gesture and flickers the
/// edit menu, so callers defer the snap until it settles.
- (BOOL)selectionGestureIsActive
{
  for (UIGestureRecognizer *recognizer in _textView.gestureRecognizers) {
    if (recognizer.state == UIGestureRecognizerStateBegan || recognizer.state == UIGestureRecognizerStateChanged) {
      return YES;
    }
  }
  return NO;
}

/// Re-applies the atomic-link snap once the selection gesture ends, polling the
/// main queue because UIKit may not re-fire the selection delegate at touch-up.
- (void)schedulePostGestureAtomicSnap
{
  if (_atomicSnapScheduled) {
    return;
  }
  _atomicSnapScheduled = YES;
  __weak __typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kENRMAtomicSnapPollInterval * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   __typeof(self) strongSelf = weakSelf;
                   if (strongSelf == nil) {
                     return;
                   }
                   strongSelf->_atomicSnapScheduled = NO;
                   if (strongSelf->_editSession.shouldSuppressSelectionSideEffects ||
                       strongSelf->_editSession.isComposing) {
                     return;
                   }
                   if ([strongSelf selectionGestureIsActive]) {
                     [strongSelf schedulePostGestureAtomicSnap];
                     return;
                   }
                   NSRange selection = strongSelf->_textView.selectedRange;
                   NSRange adjusted = [strongSelf clampedAtomicSelectionForSelection:selection];
                   if (!NSEqualRanges(adjusted, selection)) {
                     strongSelf->_textView.selectedRange = adjusted;
                   }
                 });
}

- (void)textViewDidChangeSelection:(UITextView *)textView
{
  NSRange newSelection = textView.selectedRange;
  if (!_editSession.shouldSuppressSelectionSideEffects && !_editSession.isComposing) {
    if ([self selectionGestureIsActive]) {
      [self schedulePostGestureAtomicSnap];
    } else {
      NSRange adjusted = [self clampedAtomicSelectionForSelection:newSelection];
      if (!NSEqualRanges(adjusted, newSelection)) {
        _textView.selectedRange = adjusted;
        return;
      }
    }
  }
  NSRange previousSelection = _lastSelectedRange;
  _lastSelectedRange = newSelection;

  if (_editSession.shouldSuppressSelectionSideEffects) {
    return;
  }

  if (_editSession.isComposing) {
    return;
  }

  BOOL selectionMoved =
      newSelection.location != previousSelection.location || newSelection.length != previousSelection.length;

  if (selectionMoved) {
    [_typingController resetForSelectionChange];
  }

  [self manageSelectionBasedChanges];

  [_inputEventEmitter emitOnChangeSelection];
  [self updateActiveMention];
  [_inputEventEmitter emitOnChangeState];
  [_inputEventEmitter emitCaretRectChangeIfNeeded];
  [self updateEmptyBulletMarker];
}

#else

#pragma mark - RCTBackedTextInputDelegate (macOS)

- (BOOL)textInputShouldBeginEditing
{
  return YES;
}

- (void)textInputDidBeginEditing
{
  [_inputEventEmitter emitOnFocus];
}

- (BOOL)textInputShouldEndEditing
{
  return YES;
}

- (void)textInputDidEndEditing
{
  [self clearActiveMention:nil];
  [_inputEventEmitter emitOnBlur];
}

- (BOOL)textInputShouldReturn
{
  return NO;
}

- (void)textInputDidReturn
{
}

- (BOOL)textInputShouldSubmitOnReturn
{
  return NO;
}

- (nullable NSString *)textInputShouldChangeText:(NSString *)text inRange:(NSRange)range
{
  [_inputEventEmitter emitOnKeyPress:text];
  if ([self deleteLinkForReplacementRange:range replacementText:text]) {
    return nil;
  }
  _preEditSelectedRange = _lastSelectedRange;
  // Capture the same pre-edit block state the iOS path does — otherwise these
  // ivars carry stale values from a previous edit into reconcileBlockContinuation.
  [self capturePreEditBlockForRange:range];
  _preEditParagraphWasEmpty = [self preEditParagraphWasEmpty:range];
  _preEditReplacedNewline = [self replacedRangeTouchesNewline:range];
  [_editSession enterPhase:ENRMEditPhaseProcessing];
  return text;
}

- (void)textInputDidChange
{
  if (_editSession.shouldSuppressFormatting) {
    [_editSession exitPhase];
    return;
  }
  [self handleTextChanged];
  [_editSession exitPhase];
  [_editSession recordTextChange];
  _lastSelectedRange = _textView.selectedRange;
}

- (void)textInputDidChangeSelection
{
  NSRange newSelection = _textView.selectedRange;
  if (!_editSession.shouldSuppressSelectionSideEffects && !_editSession.isComposing) {
    NSRange adjusted = [_formattingStore selectionAdjustedForAtomicLinks:newSelection];
    if (!NSEqualRanges(adjusted, newSelection)) {
      _textView.selectedRange = adjusted;
      return;
    }
  }
  NSRange previousSelection = _lastSelectedRange;
  _lastSelectedRange = newSelection;

  if (_editSession.shouldSuppressSelectionSideEffects) {
    return;
  }

  if (_editSession.isComposing) {
    return;
  }

  BOOL selectionMoved =
      newSelection.location != previousSelection.location || newSelection.length != previousSelection.length;

  if (selectionMoved) {
    [_typingController resetForSelectionChange];
  }

  [_inputEventEmitter emitOnChangeSelection];
  [self updateActiveMention];
  [_inputEventEmitter emitOnChangeState];
  [_inputEventEmitter emitCaretRectChangeIfNeeded];
}

// @required stubs for RCTBackedTextInputDelegate — RCTUITextView's internal adapter
// calls these via textInputDelegate; omitting any causes silent failures or crashes.

- (BOOL)textInputShouldHandleDeleteBackward:(id<RCTBackedTextInputViewProtocol>)sender
{
  return YES;
}

- (BOOL)textInputShouldHandleDeleteForward:(id<RCTBackedTextInputViewProtocol>)sender
{
  return YES;
}

- (BOOL)textInputShouldHandleKeyEvent:(NSEvent *)event
{
  return YES;
}

- (BOOL)hasKeyDownEventOrKeyUpEvent:(NSString *)key
{
  return NO;
}

- (NSDragOperation)textInputDraggingEntered:(id<NSDraggingInfo>)draggingInfo
{
  return NSDragOperationNone;
}

- (void)textInputDraggingExited:(id<NSDraggingInfo>)draggingInfo
{
}

- (BOOL)textInputShouldHandleDragOperation:(id<NSDraggingInfo>)draggingInfo
{
  return YES;
}

- (void)textInputDidCancel
{
}

- (BOOL)textInputShouldHandlePaste:(id<RCTBackedTextInputViewProtocol>)sender
{
  return YES;
}

- (void)automaticSpellingCorrectionDidChange:(BOOL)enabled
{
}

- (void)continuousSpellCheckingDidChange:(BOOL)enabled
{
}

- (void)grammarCheckingDidChange:(BOOL)enabled
{
}

- (void)submitOnKeyDownIfNeeded:(NSEvent *)event
{
}

#endif

@end

Class<RCTComponentViewProtocol> EnrichedMarkdownTextInputCls(void)
{
  return EnrichedMarkdownTextInput.class;
}
