#import "ENRMMathContainerView.h"
#import "ENRMAccessibilityLabels.h"
#import "ENRMFeatureFlags.h"
#import "ENRMHorizontalScrollView.h"
#include <TargetConditionals.h>

#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathFallback.h"
#import "PasteboardUtils.h"
#if __has_include("ReactNativeEnrichedMarkdown-Swift.h")
#import "ReactNativeEnrichedMarkdown-Swift.h"
#elif __has_include(<ReactNativeEnrichedMarkdown/ReactNativeEnrichedMarkdown-Swift.h>)
#import <ReactNativeEnrichedMarkdown/ReactNativeEnrichedMarkdown-Swift.h>
#endif
#if TARGET_OS_OSX
#import "ENRMMenuAction.h"
#endif
#endif

#if ENRICHED_MARKDOWN_MATH

@interface ENRMRaTeXCanvasView : RCTUIView
@property (nonatomic, strong, nullable) ENRMRaTeXRenderResult *renderResult;
// Visible-source fallback when RaTeX cannot parse the block, drawn wrapped;
// see ENRMMathFallback.h.
@property (nonatomic, strong, nullable) NSAttributedString *fallbackSource;
@end

@implementation ENRMRaTeXCanvasView

- (void)drawRect:(CGRect)rect
{
  if (!_renderResult) {
    if (_fallbackSource) {
      [_fallbackSource drawWithRect:self.bounds options:NSStringDrawingUsesLineFragmentOrigin context:nil];
    }
    return;
  }
  CGContextRef ctx = UIGraphicsGetCurrentContext();
  if (!ctx)
    return;
  [_renderResult drawIn:ctx];
}

- (CGSize)intrinsicContentSize
{
  if (!_renderResult)
    return CGSizeZero;
  return CGSizeMake(ceil(_renderResult.width), ceil(_renderResult.totalHeight));
}

@end

#if !TARGET_OS_OSX
@interface ENRMMathContainerView () <UIContextMenuInteractionDelegate>
@property (nonatomic, strong, readonly) ENRMHorizontalScrollView *scrollView;
#else
@interface ENRMMathContainerView ()
#endif
@property (nonatomic, strong, readonly) ENRMRaTeXCanvasView *mathView;
@property (nonatomic, copy, readwrite) NSString *cachedLatex;
@end

@implementation ENRMMathContainerView {
  BOOL _parseFailed;
  NSString *_parseMessage;
}

- (void)reportLatexErrorIfNeeded
{
  if (_parseFailed && self.onLatexError) {
    self.onLatexError(_cachedLatex, _parseMessage ?: @"", YES);
  }
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  self = [super initWithFrame:CGRectZero];
  if (self) {
    _config = config;
    _cachedLatex = @"";
    _dynamicProps = [[ENRMDynamicBlockProps alloc] init];

    _mathView = [[ENRMRaTeXCanvasView alloc] initWithFrame:CGRectZero];
    _mathView.backgroundColor = [RCTUIColor clearColor];

#if !TARGET_OS_OSX
    _scrollView = [[ENRMHorizontalScrollView alloc] init];
    _scrollView.showsVerticalScrollIndicator = NO;
    _scrollView.showsHorizontalScrollIndicator = YES;
    _scrollView.alwaysBounceHorizontal = NO;
    _scrollView.scrollEnabled = NO;
    [self addSubview:_scrollView];
    [_scrollView addSubview:_mathView];

    self.isAccessibilityElement = YES;

    UIContextMenuInteraction *contextMenu = [[UIContextMenuInteraction alloc] initWithDelegate:self];
    [self addInteraction:contextMenu];
#else
    [self addSubview:_mathView];
#endif
  }
  return self;
}

- (void)applyLatex:(NSString *)latex
{
  _cachedLatex = [latex copy];
  _parseFailed = NO;
  _parseMessage = nil;

  StyleConfig *config = self.config;

  NSError *error = nil;
  ENRMRaTeXRenderResult *result = [ENRMRaTeXBridge parse:latex
                                             displayMode:YES
                                                fontSize:config.mathFontSize
                                                   color:config.mathColor
                                                   error:&error];
  if (!result) {
    _parseFailed = YES;
    _parseMessage = error.localizedDescription ?: @"";
    [self reportLatexErrorIfNeeded];
  }
  _mathView.renderResult = result;
  _mathView.fallbackSource = result ? nil : ENRMMathFallbackString(latex, @"$$", config.mathFontSize, config.mathColor);

  CGFloat padding = config.mathPadding;
  _mathView.frame = CGRectMake(padding, padding, ceil(result.width), ceil(result.totalHeight));

  self.backgroundColor = config.mathBackgroundColor;

  [_mathView invalidateIntrinsicContentSize];
#if !TARGET_OS_OSX
  [_mathView setNeedsDisplay];
#else
  [_mathView setNeedsDisplay:YES];
#endif
  [self setNeedsLayout];
}

#if !TARGET_OS_OSX
- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                        configurationForMenuAtLocation:(CGPoint)location
{
  if (!self.dynamicProps.enableBlockContextMenu) {
    return nil;
  }
  return [UIContextMenuConfiguration
      configurationWithIdentifier:nil
                  previewProvider:nil
                   actionProvider:^UIMenu *(NSArray<UIMenuElement *> *suggestedActions) {
                     UIAction *copyPlainText =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.on.doc"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyLatexToPasteboard]; }];

                     UIAction *copyMarkdown =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyAsMarkdownLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.text"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyMarkdownToPasteboard]; }];

                     return [UIMenu menuWithTitle:@"" children:@[ copyPlainText, copyMarkdown ]];
                   }];
}
#endif

#if TARGET_OS_OSX
- (NSMenu *)menuForEvent:(NSEvent *)event
{
  if (!self.dynamicProps.enableBlockContextMenu) {
    return nil;
  }
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyLabel, ^{ [self copyLatexToPasteboard]; })];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyAsMarkdownLabel, ^{ [self copyMarkdownToPasteboard]; })];
  return menu;
}
#endif

- (void)copyLatexToPasteboard
{
  copyStringToPasteboard(_cachedLatex);
}

- (void)copyMarkdownToPasteboard
{
  copyStringToPasteboard([NSString stringWithFormat:@"$$\n%@\n$$", _cachedLatex]);
}

- (CGSize)mathViewIntrinsicSize
{
  return _mathView.intrinsicContentSize;
}

- (CGFloat)measureHeight:(CGFloat)maxWidth
{
  CGFloat padding = self.config.mathPadding;
  if (!_mathView.renderResult && _mathView.fallbackSource) {
    CGFloat available = MAX(maxWidth - padding * 2, 1);
    CGRect bounds = [_mathView.fallbackSource boundingRectWithSize:CGSizeMake(available, CGFLOAT_MAX)
                                                           options:NSStringDrawingUsesLineFragmentOrigin
                                                           context:nil];
    return ceil(bounds.size.height) + padding * 2;
  }
  return [self mathViewIntrinsicSize].height + padding * 2;
}

+ (CGFloat)measureHeightForLatex:(NSString *)latex config:(StyleConfig *)config maxWidth:(CGFloat)maxWidth
{
  CGFloat padding = config.mathPadding;

  ENRMRaTeXRenderResult *result = [ENRMRaTeXBridge parse:latex
                                             displayMode:YES
                                                fontSize:config.mathFontSize
                                                   color:config.mathColor];
  if (result) {
    return ceil(result.totalHeight) + padding * 2;
  }

  NSAttributedString *fallbackSource = ENRMMathFallbackString(latex, @"$$", config.mathFontSize, config.mathColor);
  if (!fallbackSource) {
    return 0;
  }
  CGFloat available = MAX(maxWidth - padding * 2, 1);
  CGRect bounds = [fallbackSource boundingRectWithSize:CGSizeMake(available, CGFLOAT_MAX)
                                               options:NSStringDrawingUsesLineFragmentOrigin
                                               context:nil];
  return ceil(bounds.size.height) + padding * 2;
}

- (CGFloat)alignedOriginXForWidth:(CGFloat)formulaWidth inBounds:(CGFloat)boundsWidth padding:(CGFloat)padding
{
  CGFloat available = boundsWidth - padding * 2;
  if (formulaWidth >= available)
    return padding;

  NSString *align = self.config.mathTextAlign;
  if ([align isEqualToString:@"left"])
    return padding;
  if ([align isEqualToString:@"right"])
    return padding + available - formulaWidth;
  return padding + (available - formulaWidth) / 2.0;
}

- (void)layoutSubviews
{
  [super layoutSubviews];

  CGFloat padding = self.config.mathPadding;

  if (!_mathView.renderResult && _mathView.fallbackSource) {
    // Fallback source fills the available width and wraps; no horizontal scroll.
#if !TARGET_OS_OSX
    _scrollView.frame = self.bounds;
    _scrollView.contentSize = self.bounds.size;
    _scrollView.contentOffset = CGPointZero;
    _scrollView.scrollEnabled = NO;
#endif
    _mathView.frame = CGRectMake(padding, padding, MAX(self.bounds.size.width - padding * 2, 1),
                                 MAX(self.bounds.size.height - padding * 2, 1));
#if !TARGET_OS_OSX
    [_mathView setNeedsDisplay];
#else
    [_mathView setNeedsDisplay:YES];
#endif
    return;
  }

  CGSize intrinsicSize = [self mathViewIntrinsicSize];
  CGFloat contentWidth = intrinsicSize.width + padding * 2;
  CGFloat contentHeight = self.bounds.size.height;
  BOOL overflows = contentWidth > self.bounds.size.width;
  CGFloat originX = [self alignedOriginXForWidth:intrinsicSize.width inBounds:self.bounds.size.width padding:padding];

#if !TARGET_OS_OSX
  _scrollView.frame = self.bounds;
  _scrollView.contentSize = CGSizeMake(overflows ? contentWidth : self.bounds.size.width, contentHeight);
  _scrollView.scrollEnabled = overflows;
  _mathView.frame = CGRectMake(originX, padding, intrinsicSize.width, intrinsicSize.height);
#else
  _mathView.frame = CGRectMake(originX, padding, intrinsicSize.width, intrinsicSize.height);
  [_mathView setNeedsDisplay:YES];
#endif
}

#if TARGET_OS_OSX
- (void)layout
{
  [super layout];
  [self layoutSubviews];
}
#endif

- (NSString *)accessibilityLabel
{
  return [_accessibilityLabels.mathEquation stringByReplacingOccurrencesOfString:@"{latex}"
                                                                      withString:_cachedLatex ?: @""];
}

#if !TARGET_OS_OSX
- (UIAccessibilityTraits)accessibilityTraits
{
  return UIAccessibilityTraitStaticText;
}
#endif

@end

#endif
