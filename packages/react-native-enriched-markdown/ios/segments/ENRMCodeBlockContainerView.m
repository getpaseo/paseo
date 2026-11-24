#import "ENRMCodeBlockContainerView.h"
#import "ENRMCodeBlockContent.h"
#import "ENRMCodeBlockHighlighter.h"
#import "ENRMHorizontalScrollView.h"
#import "MarkdownASTNode.h"
#import "PasteboardUtils.h"
#if TARGET_OS_OSX
#import "ENRMMenuAction.h"
#endif

// Block segment view for fenced code blocks (see SegmentRenderer.m):
// a fixed header bar (language name, copy button) above a horizontally
// scrolling, non-wrapping code pane. The container's drawRect: draws
// background, border, label, and divider; only the copy button and the
// scroll view are subviews. Syntax coloring comes from the
// ENRMCodeBlockHighlighter seam and falls back to plain text. The box
// visuals must stay in sync with the commonmark flavor's CodeBlockBackground.
//
// measureHeight: must stay in sync with the drawn content: it uses the
// unconstrained bounding rect of the same attributed string and the same
// header metrics, so the reported height matches the drawn height. Since
// lines never wrap, the height is independent of the available width.

static const CGFloat kENRMHeaderLabelScale = 0.85;
// The copy glyph reads cleaner a touch smaller than the language label and at a
// regular (not medium) weight; sized independently so the two never couple.
static const CGFloat kENRMHeaderIconScale = 0.72;
static const CGFloat kENRMHeaderSecondaryAlpha = 0.6;
static const CGFloat kENRMHeaderDividerAlpha = 0.2;

// Height geometry and code-run construction shared by the instance layout path
// and the view-free measureHeightForCodeBlockNode:, so the two cannot drift.

static CGFloat ENRMCodeBlockContentInset(StyleConfig *config)
{
  return [config codeBlockPadding] + [config codeBlockBorderWidth];
}

#if !TARGET_OS_OSX
static UIFont *ENRMCodeBlockHeaderFont(StyleConfig *config)
{
  return [UIFont systemFontOfSize:[config codeBlockFont].pointSize * kENRMHeaderLabelScale weight:UIFontWeightMedium];
}

static CGFloat ENRMCodeBlockHeaderLabelLineHeight(UIFont *headerFont)
{
  return ceil(UIFontLineHeight(headerFont));
}
#else
static NSFont *ENRMCodeBlockHeaderFont(StyleConfig *config)
{
  return [NSFont systemFontOfSize:[config codeBlockFont].pointSize * kENRMHeaderLabelScale weight:NSFontWeightMedium];
}

static CGFloat ENRMCodeBlockHeaderLabelLineHeight(NSFont *headerFont)
{
  return ceil(UIFontLineHeight(headerFont));
}
#endif

static NSAttributedString *ENRMCodeBlockPlainAttributedCode(NSString *code, StyleConfig *config)
{
  if (code.length == 0) {
    return [[NSAttributedString alloc] initWithString:@""];
  }
  NSMutableAttributedString *attributed = [[NSMutableAttributedString alloc] initWithString:code];
  ENRMApplyCodeBlockTextAttributes(attributed, NSMakeRange(0, attributed.length), config);
  return attributed;
}

// Per-line height applied to the code text (see ENRMApplyCodeBlockTextAttributes):
// when a code block line height is configured every line fragment is exactly that
// tall; otherwise the font's natural line height is used.
static CGFloat ENRMCodeBlockPerLineHeight(StyleConfig *config)
{
  CGFloat lineHeight = [config codeBlockLineHeight];
  return lineHeight > 0 ? lineHeight : ceil(UIFontLineHeight([config codeBlockFont]));
}

// Analytic code height: lines never wrap and each fragment is a fixed height, so
// the laid-out height is simply lineCount * perLineHeight. No text layout needed,
// which is what boundingRectWithSize used to do on the whole block.
static CGFloat ENRMCodeBlockCodeHeight(NSString *code, StyleConfig *config)
{
  if (code.length == 0) {
    return 0;
  }
  __block NSUInteger lineCount = 0;
  [code enumerateSubstringsInRange:NSMakeRange(0, code.length)
                           options:NSStringEnumerationByLines | NSStringEnumerationSubstringNotRequired
                        usingBlock:^(NSString *_Nullable substring, NSRange substringRange, NSRange enclosingRange,
                                     BOOL *stop) { lineCount++; }];
  if (lineCount == 0) {
    lineCount = 1;
  }
  return ceil(lineCount * ENRMCodeBlockPerLineHeight(config));
}

// Used only to pick the scroll indicator style for the code pane, so the
// indicator stays visible on dark code block backgrounds without affecting
// any other scroll view.
static BOOL ENRMColorIsDark(RCTUIColor *color)
{
  if (!color) {
    return NO;
  }
  CGFloat r = 0, g = 0, b = 0, a = 0;
#if !TARGET_OS_OSX
  if (![color getRed:&r green:&g blue:&b alpha:&a]) {
    CGFloat white = 0;
    if (![color getWhite:&white alpha:&a]) {
      return NO;
    }
    r = g = b = white;
  }
#else
  NSColor *rgb = [color colorUsingColorSpace:[NSColorSpace sRGBColorSpace]];
  if (!rgb) {
    return NO;
  }
  [rgb getRed:&r green:&g blue:&b alpha:&a];
#endif
  return (0.299 * r + 0.587 * g + 0.114 * b) < 0.5;
}

// Scrollable code pane content. Draws the attributed code unwrapped at a
// fixed origin; the hosting ENRMCodeBlockContainerView draws everything else.
//
// The TextKit stack (storage/layout manager/container) is built and laid out
// once, when attributedCode is set, then cached: drawRect: only paints the
// already-computed glyphs, so scrolling and redraws never re-lay-out. This is
// the same rendering path drawAtPoint used internally, so output is identical,
// but the layout is no longer thrown away on every draw. The container is
// unbounded (lines never wrap) with zero line-fragment padding and font leading
// disabled, matching the NSStringDrawing origin the block used before.
@interface ENRMCodeBlockContentView : RCTUIView
@property (nonatomic, strong, nullable) NSAttributedString *attributedCode;
@property (nonatomic, assign) CGPoint textOrigin;
// Laid-out content width, for the horizontal scroll extent. Free once the
// cached stack exists; no separate measurement pass.
@property (nonatomic, readonly) CGFloat usedWidth;
#if TARGET_OS_OSX
@property (nonatomic, copy, nullable) NSMenu * (^menuProvider)(void);
#endif
@end

@implementation ENRMCodeBlockContentView {
  NSTextStorage *_textStorage;
  NSLayoutManager *_layoutManager;
  NSTextContainer *_textContainer;
}

#if TARGET_OS_OSX
- (BOOL)isFlipped
{
  return YES;
}

- (NSMenu *)menuForEvent:(NSEvent *)event
{
  return self.menuProvider ? self.menuProvider() : [super menuForEvent:event];
}
#endif

- (void)setAttributedCode:(nullable NSAttributedString *)attributedCode
{
  _attributedCode = attributedCode;
  if (attributedCode.length == 0) {
    _textStorage = nil;
    _layoutManager = nil;
    _textContainer = nil;
    return;
  }
  _textStorage = [[NSTextStorage alloc] initWithAttributedString:attributedCode];
  _layoutManager = [[NSLayoutManager alloc] init];
  _layoutManager.usesFontLeading = ENRMLayoutManagerUsesFontLeading;
  _textContainer = [[NSTextContainer alloc] initWithSize:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)];
  _textContainer.lineFragmentPadding = 0;
  _textContainer.maximumNumberOfLines = 0;
  [_layoutManager addTextContainer:_textContainer];
  [_textStorage addLayoutManager:_layoutManager];
  [_layoutManager ensureLayoutForTextContainer:_textContainer];
}

- (CGFloat)usedWidth
{
  if (!_layoutManager) {
    return 0;
  }
  return ceil([_layoutManager usedRectForTextContainer:_textContainer].size.width);
}

- (void)drawRect:(CGRect)rect
{
  if (!_layoutManager) {
    return;
  }
  // Only paint the glyphs intersecting the dirty rect; tall blocks skip their
  // off-screen lines. The rect is in view space, the layout in container space.
  CGRect boundingRect = CGRectOffset(rect, -self.textOrigin.x, -self.textOrigin.y);
  NSRange glyphRange = [_layoutManager glyphRangeForBoundingRect:boundingRect inTextContainer:_textContainer];
  [_layoutManager drawGlyphsForGlyphRange:glyphRange atPoint:self.textOrigin];
}

@end

#if !TARGET_OS_OSX
@interface ENRMCodeBlockContainerView () <UIContextMenuInteractionDelegate, UIGestureRecognizerDelegate>
@end
#endif

@implementation ENRMCodeBlockContainerView {
  NSAttributedString *_attributedCode;
  NSString *_cachedCode;
  NSString *_cachedLanguage;
  NSString *_displayLanguage;
  NSString *_fenceChar;
  ENRMHorizontalScrollView *_scrollView;
  ENRMCodeBlockContentView *_codeContentView;
  CGSize _codeSize;
  CGFloat _headerLabelLineHeight;
  NSAttributedString *_languageLabel;
  CGSize _languageLabelSize;
#if !TARGET_OS_OSX
  UIFont *_headerFont;
  UIButton *_copyButton;
  UITapGestureRecognizer *_tapRecognizer;
#else
  NSFont *_headerFont;
  NSButton *_copyButton;
#endif
}

- (void)setPending:(BOOL)pending
{
  if (_pending == pending) {
    return;
  }
  _pending = pending;
  // Header stays visible while streaming; only copying is held back.
  _copyButton.enabled = !pending;
  // The reconciler can reuse an unchanged block without re-applying the node, so
  // re-derive here to pick up highlighting once the block closes.
  [self rebuildAttributedCode];
#if !TARGET_OS_OSX
  [self setNeedsLayout];
  [self setNeedsDisplay];
  [_codeContentView setNeedsDisplay];
#else
  self.needsLayout = YES;
  [self setNeedsDisplay:YES];
  [_codeContentView setNeedsDisplay:YES];
#endif
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  self = [super initWithFrame:CGRectZero];
  if (self) {
    _config = config;
    _cachedCode = @"";
    _fenceChar = @"`";
    _dynamicProps = [[ENRMDynamicBlockProps alloc] init];
    _headerFont = ENRMCodeBlockHeaderFont(config);
    _headerLabelLineHeight = ENRMCodeBlockHeaderLabelLineHeight(_headerFont);
    self.backgroundColor = [RCTUIColor clearColor];
    [self setupScrollView];

#if !TARGET_OS_OSX
    self.contentMode = UIViewContentModeRedraw;
    self.isAccessibilityElement = YES;

    UIContextMenuInteraction *contextMenu = [[UIContextMenuInteraction alloc] initWithDelegate:self];
    [self addInteraction:contextMenu];

    _copyButton = [UIButton buttonWithType:UIButtonTypeSystem];
    UIImageSymbolConfiguration *symbolConfig =
        [UIImageSymbolConfiguration configurationWithPointSize:[config codeBlockFont].pointSize * kENRMHeaderIconScale
                                                        weight:UIImageSymbolWeightRegular];
    [_copyButton setImage:[UIImage systemImageNamed:@"doc.on.doc" withConfiguration:symbolConfig]
                 forState:UIControlStateNormal];
    _copyButton.tintColor = [[config codeBlockColor] colorWithAlphaComponent:kENRMHeaderSecondaryAlpha];
    [_copyButton addTarget:self action:@selector(copyCodeToPasteboard) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:_copyButton];

    _tapRecognizer = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(handleCodeBlockTap:)];
    _tapRecognizer.delegate = self;
    [self addGestureRecognizer:_tapRecognizer];
#else
    NSImageSymbolConfiguration *symbolConfig =
        [NSImageSymbolConfiguration configurationWithPointSize:[config codeBlockFont].pointSize * kENRMHeaderIconScale
                                                        weight:NSFontWeightRegular];
    NSImage *copyImage = [[NSImage imageWithSystemSymbolName:@"doc.on.doc"
                                    accessibilityDescription:nil] imageWithSymbolConfiguration:symbolConfig];
    _copyButton = [NSButton buttonWithImage:copyImage target:self action:@selector(copyCodeToPasteboard)];
    _copyButton.bordered = NO;
    _copyButton.contentTintColor = [[config codeBlockColor] colorWithAlphaComponent:kENRMHeaderSecondaryAlpha];
    [self addSubview:_copyButton];
#endif
  }
  return self;
}

- (void)setupScrollView
{
  _scrollView = [[ENRMHorizontalScrollView alloc] init];
  _scrollView.showsVerticalScrollIndicator = NO;
  _scrollView.showsHorizontalScrollIndicator = YES;
  _codeContentView = [[ENRMCodeBlockContentView alloc] initWithFrame:CGRectZero];
  BOOL darkBackground = ENRMColorIsDark([_config codeBlockBackgroundColor]);
#if !TARGET_OS_OSX
  _scrollView.alwaysBounceHorizontal = NO;
  _scrollView.backgroundColor = [UIColor clearColor];
  _scrollView.isAccessibilityElement = NO;
  _scrollView.accessibilityElementsHidden = YES;
  _scrollView.indicatorStyle = darkBackground ? UIScrollViewIndicatorStyleWhite : UIScrollViewIndicatorStyleDefault;
  _codeContentView.backgroundColor = [UIColor clearColor];
  _codeContentView.contentMode = UIViewContentModeRedraw;
  [_scrollView addSubview:_codeContentView];
  [_codeContentView addInteraction:[[UIContextMenuInteraction alloc] initWithDelegate:self]];
#else
  ((NSScrollView *)_scrollView).drawsBackground = NO;
  ((NSScrollView *)_scrollView).scrollerKnobStyle =
      darkBackground ? NSScrollerKnobStyleLight : NSScrollerKnobStyleDefault;
  __weak ENRMCodeBlockContainerView *weakSelf = self;
  NSMenu * (^menuProvider)(void) = ^{ return [weakSelf buildContextMenu]; };
  _codeContentView.menuProvider = menuProvider;
  [(NSScrollView *)_scrollView setDocumentView:_codeContentView];
#endif
  [self addSubview:_scrollView];
}

- (void)layoutScrollArea
{
  CGFloat borderW = ceil([_config codeBlockBorderWidth]);
  CGFloat headerH = [self headerHeight];
  CGFloat inset = [self contentInset];
  CGRect frame = CGRectMake(borderW, headerH, MAX(self.bounds.size.width - borderW * 2, 0),
                            MAX(self.bounds.size.height - headerH - borderW, 0));
  _scrollView.frame = frame;

  CGFloat horizontalPad = MAX(inset - borderW, 0);
  CGFloat contentWidth = MAX(_codeSize.width + horizontalPad * 2, frame.size.width);
  _codeContentView.textOrigin = CGPointMake(horizontalPad, inset);
  _codeContentView.frame = CGRectMake(0, 0, contentWidth, frame.size.height);
#if !TARGET_OS_OSX
  _scrollView.contentSize = CGSizeMake(contentWidth, frame.size.height);
  _scrollView.scrollEnabled = contentWidth > frame.size.width;
#endif
}

// The code pane starts after the content inset and one header-label line.
- (CGFloat)headerHeight
{
  return [self contentInset] + _headerLabelLineHeight;
}

- (CGFloat)headerCenterY
{
  // The divider sits halfway into the code pane's top inset.
  return ([self headerHeight] + [self contentInset] / 2) / 2;
}

- (void)layoutHeaderButton
{
  CGFloat headerH = [self headerHeight];
  CGFloat iconWidth = _copyButton.intrinsicContentSize.width;
  if (iconWidth <= 0 || iconWidth > headerH) {
    iconWidth = headerH;
  }
  CGFloat iconSlack = (headerH - iconWidth) / 2;
  CGFloat buttonLeft = MAX(self.bounds.size.width - [self contentInset] - headerH + iconSlack, 0);
  CGFloat buttonTop = MAX([self headerCenterY] - headerH / 2, 0);
  _copyButton.frame = CGRectMake(buttonLeft, buttonTop, headerH, headerH);
}

#if !TARGET_OS_OSX
- (void)layoutSubviews
{
  [super layoutSubviews];
  [self layoutHeaderButton];
  [self layoutScrollArea];
}
#else
- (void)layout
{
  [super layout];
  [self layoutHeaderButton];
  [self layoutScrollArea];
}
#endif

#if TARGET_OS_OSX
- (BOOL)isFlipped
{
  return YES;
}

- (void)setFrameSize:(NSSize)newSize
{
  [super setFrameSize:newSize];
  [self setNeedsDisplay:YES];
}
#endif

// Highlighting is deferred while pending, applied once the block closes.
- (void)rebuildAttributedCode
{
  NSAttributedString *plainCode = [self plainAttributedCode];
  NSAttributedString *highlighted =
      _pending ? nil : ENRMHighlightedAttributedCode(plainCode, _cachedCode, _cachedLanguage, _config);
  _attributedCode = highlighted ?: plainCode;
  // Setting attributedCode builds and lays out the cached TextKit stack once;
  // width then reads out of that layout, and height stays analytic.
  _codeContentView.attributedCode = _attributedCode;
  _codeSize = CGSizeMake(_codeContentView.usedWidth, ENRMCodeBlockCodeHeight(_cachedCode, _config));
}

- (void)applyCodeBlockNode:(MarkdownASTNode *)node
{
  _cachedCode = ENRMCodeBlockExtractCode(node);
  _fenceChar = ENRMCodeBlockFenceChar(node);

  NSString *newLanguage = ENRMCodeBlockLanguage(node);
  BOOL languageChanged = newLanguage != _cachedLanguage && ![newLanguage isEqualToString:_cachedLanguage];
  if (languageChanged) {
    _cachedLanguage = newLanguage;
    _displayLanguage = ENRMCodeBlockDisplayLanguageName(newLanguage);
    [self rebuildLanguageLabel];
  }

  [self rebuildAttributedCode];

  // iOS VoiceOver reads the copy label live via accessibilityCustomActions and the
  // button is hidden behind the container's single a11y element, so its own label
  // is consumed only on macOS; refresh it there on each content update.
#if TARGET_OS_OSX
  _copyButton.accessibilityLabel = self.dynamicProps.menuCopyLabel;
#endif

#if !TARGET_OS_OSX
  [self setNeedsLayout];
  [self setNeedsDisplay];
  [_codeContentView setNeedsDisplay];
#else
  self.needsLayout = YES;
  [self setNeedsDisplay:YES];
  [_codeContentView setNeedsDisplay:YES];
#endif
}

- (void)rebuildLanguageLabel
{
  if (_displayLanguage.length == 0) {
    _languageLabel = nil;
    _languageLabelSize = CGSizeZero;
    return;
  }
  NSMutableDictionary *labelAttributes = [NSMutableDictionary dictionary];
  labelAttributes[NSFontAttributeName] = _headerFont;
  RCTUIColor *labelColor = [[_config codeBlockColor] colorWithAlphaComponent:kENRMHeaderSecondaryAlpha];
  if (labelColor) {
    labelAttributes[NSForegroundColorAttributeName] = labelColor;
  }
  _languageLabel = [[NSAttributedString alloc] initWithString:_displayLanguage attributes:labelAttributes];
  _languageLabelSize = _languageLabel.size;
}

- (NSAttributedString *)plainAttributedCode
{
  return ENRMCodeBlockPlainAttributedCode(_cachedCode, _config);
}

- (CGFloat)contentInset
{
  return ENRMCodeBlockContentInset(_config);
}

- (CGFloat)measureHeight:(CGFloat)maxWidth
{
  CGFloat inset = [self contentInset];
  return _codeSize.height + inset * 2 + [self headerHeight];
}

+ (CGFloat)measureHeightForCodeBlockNode:(MarkdownASTNode *)node config:(StyleConfig *)config
{
  CGFloat inset = ENRMCodeBlockContentInset(config);
  CGFloat headerH = inset + ENRMCodeBlockHeaderLabelLineHeight(ENRMCodeBlockHeaderFont(config));
  CGFloat codeHeight = ENRMCodeBlockCodeHeight(ENRMCodeBlockExtractCode(node), config);
  return codeHeight + inset * 2 + headerH;
}

- (void)drawRect:(CGRect)rect
{
  CGFloat borderWidth = [_config codeBlockBorderWidth];
  CGFloat radius = [_config codeBlockBorderRadius];
  CGRect borderRect = CGRectInset(self.bounds, borderWidth / 2, borderWidth / 2);

#if !TARGET_OS_OSX
  UIBezierPath *path = [UIBezierPath bezierPathWithRoundedRect:borderRect cornerRadius:radius];
#else
  NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:borderRect xRadius:radius yRadius:radius];
#endif

  RCTUIColor *backgroundColor = [_config codeBlockBackgroundColor];
  if (backgroundColor) {
    [backgroundColor setFill];
    [path fill];
  }
  if (borderWidth > 0) {
    RCTUIColor *borderColor = [_config codeBlockBorderColor];
    if (borderColor) {
      path.lineWidth = borderWidth;
      [borderColor setStroke];
      [path stroke];
    }
  }

  CGFloat inset = [self contentInset];
  CGFloat headerH = [self headerHeight];

  // Divider between the header and the code, centered in the gap the code
  // text's top inset creates, so it adds no height of its own.
  RCTUIColor *dividerColor = [[_config codeBlockColor] colorWithAlphaComponent:kENRMHeaderDividerAlpha];
  if (dividerColor) {
    CGRect dividerRect = CGRectMake(borderWidth, headerH + inset / 2, self.bounds.size.width - borderWidth * 2, 1);
    [dividerColor setFill];
#if !TARGET_OS_OSX
    [[UIBezierPath bezierPathWithRect:dividerRect] fill];
#else
    [[NSBezierPath bezierPathWithRect:dividerRect] fill];
#endif
  }

  if (_languageLabel.length > 0) {
    [_languageLabel drawAtPoint:CGPointMake(inset, [self headerCenterY] - _languageLabelSize.height / 2)];
  }
}

- (NSString *)fencedMarkdown
{
  return ENRMCodeBlockFencedMarkdown(_cachedCode, _cachedLanguage, _fenceChar);
}

- (void)copyCodeToPasteboard
{
  copyStringToPasteboard(_cachedCode);
  if (self.onCopyPress) {
    self.onCopyPress(_cachedCode ?: @"", _cachedLanguage ?: @"");
  }
}

- (void)copyMarkdownToPasteboard
{
  copyStringToPasteboard([self fencedMarkdown]);
}

#if !TARGET_OS_OSX
- (void)handleCodeBlockTap:(UITapGestureRecognizer *)recognizer
{
  if (!self.dynamicProps.enableCodeBlockPress || _pending) {
    return;
  }
  if (self.onCodeBlockPress) {
    self.onCodeBlockPress(_cachedCode ?: @"", _cachedLanguage ?: @"");
  }
}

- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)gestureRecognizer
{
  if (gestureRecognizer == _tapRecognizer) {
    return self.dynamicProps.enableCodeBlockPress && !_pending;
  }
  return YES;
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch
{
  // Let the copy button handle its own tap.
  for (UIView *hit = touch.view; hit != nil; hit = hit.superview) {
    if (hit == _copyButton) {
      return NO;
    }
  }
  return YES;
}
#endif

#if !TARGET_OS_OSX
- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                        configurationForMenuAtLocation:(CGPoint)location
{
  if (!self.dynamicProps.enableBlockContextMenu || _pending) {
    return nil;
  }
  return [UIContextMenuConfiguration
      configurationWithIdentifier:nil
                  previewProvider:nil
                   actionProvider:^UIMenu *(NSArray<UIMenuElement *> *suggestedActions) {
                     UIAction *copyCode =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.on.doc"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyCodeToPasteboard]; }];

                     UIAction *copyMarkdown =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyAsMarkdownLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.text"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyMarkdownToPasteboard]; }];

                     return [UIMenu menuWithTitle:@"" children:@[ copyCode, copyMarkdown ]];
                   }];
}
#endif

#if TARGET_OS_OSX
- (NSMenu *)buildContextMenu
{
  if (!self.dynamicProps.enableBlockContextMenu || _pending) {
    return nil;
  }
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyLabel, ^{ [self copyCodeToPasteboard]; })];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyAsMarkdownLabel, ^{ [self copyMarkdownToPasteboard]; })];
  return menu;
}

- (NSMenu *)menuForEvent:(NSEvent *)event
{
  return [self buildContextMenu];
}
#endif

- (NSString *)accessibilityLabel
{
  return _cachedCode;
}

#if !TARGET_OS_OSX
- (UIAccessibilityTraits)accessibilityTraits
{
  return UIAccessibilityTraitStaticText;
}

// The container is a single accessibility element, which hides the copy
// button subview from VoiceOver; expose the copy action explicitly instead.
- (NSArray<UIAccessibilityCustomAction *> *)accessibilityCustomActions
{
  if (_pending || self.dynamicProps.menuCopyLabel.length == 0) {
    return @[];
  }
  UIAccessibilityCustomAction *copyAction =
      [[UIAccessibilityCustomAction alloc] initWithName:self.dynamicProps.menuCopyLabel
                                                 target:self
                                               selector:@selector(performCopyAccessibilityAction:)];
  return @[ copyAction ];
}

- (BOOL)performCopyAccessibilityAction:(UIAccessibilityCustomAction *)action
{
  [self copyCodeToPasteboard];
  return YES;
}
#endif

@end
