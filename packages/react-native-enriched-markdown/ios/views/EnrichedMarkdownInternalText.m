#import "EnrichedMarkdownInternalText.h"
#import "ENRMAccessibilityLabels.h"
#import "ENRMContextMenuTextView+macOS.h"
#import "ENRMImageAttachment.h"
#import "ENRMMarkdownTextView.h"
#import "ENRMSpoilerOverlayManager.h"
#import "ENRMTextViewSetup.h"
#import "MarkdownAccessibilityElementBuilder.h"
#import "MarkdownExtractor.h"
#import "PasteboardUtils.h"
#import "RuntimeKeys.h"
#include <TargetConditionals.h>

@interface EnrichedMarkdownInternalText () <ENRMImageLayoutObserver>
@end

@implementation EnrichedMarkdownInternalText {
  ENRMPlatformTextView *_textView;
#if !TARGET_OS_OSX
  NSMutableArray<UIAccessibilityElement *> *_accessibilityElements;
#else
  NSMutableArray *_accessibilityElements;
#endif
  BOOL _accessibilityNeedsRebuild;
  ENRMSpoilerOverlayManager *_spoilerManager;
}

@synthesize textView = _textView;
@synthesize spoilerManager = _spoilerManager;

- (instancetype)initWithConfig:(StyleConfig *)config
{
  if (self = [super init]) {
    _config = config;
    _allowTrailingMargin = NO;
    _lastElementMarginBottom = 0;
    [self setupTextView];
  }
  return self;
}

- (void)setupTextView
{
#if !TARGET_OS_OSX
  ENRMMarkdownTextView *markdownTextView = [[ENRMMarkdownTextView alloc] init];
  __weak EnrichedMarkdownInternalText *weakCopyOwner = self;
  markdownTextView.copySelectionHandler = ^(NSRange range) {
    EnrichedMarkdownInternalText *owner = weakCopyOwner;
    if (!owner)
      return;
    NSAttributedString *text = owner->_textView.textStorage;
    copyAttributedStringToPasteboard([text attributedSubstringFromRange:range],
                                     extractMarkdownFromAttributedString(text, range), owner -> _config);
  };
  _textView = markdownTextView;
  _textView.text = @"";
#else
  _textView = [[ENRMContextMenuTextView alloc] init];
  _textView.string = @"";
#endif
  ENRMConfigureMarkdownTextView(_textView);

  [self addSubview:_textView];

  [self setupLayoutManager];

  _spoilerManager = [[ENRMSpoilerOverlayManager alloc] initWithTextView:_textView config:_config];
  _spoilerManager.spoilerOverlay = _spoilerOverlay;
}

- (void)setupLayoutManager
{
  ENRMAttachLayoutManager(_textView, _config);
}

- (void)setSpoilerOverlay:(ENRMSpoilerOverlay)spoilerOverlay
{
  _spoilerOverlay = spoilerOverlay;
  _spoilerManager.spoilerOverlay = spoilerOverlay;
}

- (void)applyAttributedText:(NSMutableAttributedString *)text context:(RenderContext *)context
{
  NSLayoutManager *layoutManager = _textView.layoutManager;
  if ([layoutManager isKindOfClass:[TextViewLayoutManager class]]) {
    [layoutManager setValue:_config forKey:@"config"];
  }

  objc_setAssociatedObject(_textView.textContainer, kTextViewKey, _textView, OBJC_ASSOCIATION_ASSIGN);

  _accessibilityElements = nil;
  _accessibilityNeedsRebuild = YES;

  ENRMSetAttributedText(_textView, text);

  [_textView.layoutManager invalidateLayoutForCharacterRange:NSMakeRange(0, text.length) actualCharacterRange:NULL];

  [_spoilerManager setNeedsUpdate];
  [self setNeedsLayout];

#if !TARGET_OS_OSX
  [_textView setNeedsLayout];
#endif
  ENRMSetNeedsDisplay(_textView);
}

- (CGFloat)measureHeight:(CGFloat)maxWidth
{
  return [self measureSize:maxWidth].height;
}

- (CGSize)measureSize:(CGFloat)maxWidth
{
  return ENRMMeasureMarkdownText(_textView, maxWidth, _config, _allowTrailingMargin, _lastElementMarginBottom);
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  _textView.frame = self.bounds;

  [_spoilerManager updateIfNeeded];
}

// An attachment that settles after render (an image's box, a link pill giving up its icon
// slot) moves the text around it, and the spoiler overlays with it.
- (void)imageAttachmentDidResolveLayout
{
  [_spoilerManager setNeedsUpdate];
  [_spoilerManager updateIfNeeded];
  [[(RCTUIView *)self.superview enrm_imageLayoutObserver] imageAttachmentDidResolveLayout];
}

#pragma mark - Accessibility

- (void)rebuildAccessibilityElementsIfNeeded
{
  if (!_accessibilityNeedsRebuild) {
    return;
  }
  _accessibilityNeedsRebuild = NO;
#if !TARGET_OS_OSX
  _accessibilityElements = [MarkdownAccessibilityElementBuilder buildElementsForTextView:_textView
                                                                                    info:_accessibilityInfo
                                                                                  labels:_accessibilityLabels
                                                                               container:self];
#endif
}

- (BOOL)isAccessibilityElement
{
  return NO;
}

- (NSInteger)accessibilityElementCount
{
  [self rebuildAccessibilityElementsIfNeeded];
  return _accessibilityElements.count;
}

- (id)accessibilityElementAtIndex:(NSInteger)index
{
  [self rebuildAccessibilityElementsIfNeeded];
  if (index < 0 || index >= (NSInteger)_accessibilityElements.count) {
    return nil;
  }
  return _accessibilityElements[index];
}

- (NSInteger)indexOfAccessibilityElement:(id)element
{
  [self rebuildAccessibilityElementsIfNeeded];
  return [_accessibilityElements indexOfObject:element];
}

- (NSArray *)accessibilityElements
{
  [self rebuildAccessibilityElementsIfNeeded];
  return _accessibilityElements;
}

#if TARGET_OS_OSX
- (void)setContextMenuProvider:(ENRMContextMenuProvider)provider
{
  ((ENRMContextMenuTextView *)_textView).contextMenuProvider = provider;
}
#endif

@end
