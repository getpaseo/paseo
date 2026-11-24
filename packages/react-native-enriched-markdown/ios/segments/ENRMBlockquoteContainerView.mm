#import "ENRMBlockquoteContainerView.h"
#import "ENRMAdmonitionIcons.h"
#import "ENRMCodeBlockContainerView.h"
#import "ENRMFeatureFlags.h"
#import "ENRMLinkContextMenus.h"
#import "ENRMSegmentHeightMeasurer.h"
#import "ENRMTableIOSGridView.h"
#import "ENRMTextInteractionUtils.h"
#import "ENRMTextRenderer.h"
#import "EnrichedMarkdownInternalText.h"
#import "LinkTapUtils.h"
#import "MarkdownASTNode.h"
#import "MarkdownASTSerializer.h"
#import "PasteboardUtils.h"
#import "SegmentRenderer.h"
#import "TableContainerView.h"
#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathContainerView.h"
#endif
#if ENRICHED_MARKDOWN_VIDEO
#import "ENRMVideoContainerView.h"
#endif
#if TARGET_OS_OSX
#import "ENRMMenuAction.h"
#endif

// Inner content is rendered with trailing margins disabled; the quote's own
// vertical inset provides the bottom gap, and per-segment margins between children
// still apply (allowTrailingMargin only gates the last child's bottom margin). The
// consumer's allowFontScaling / lineBreakStrategy are threaded through so the
// quote's content honors them the same way the root document path does.
static NSArray<ENRMRenderedSegment *> *ENRMRenderBlockquoteChildren(MarkdownASTNode *node, StyleConfig *config,
                                                                    BOOL allowFontScaling,
                                                                    NSLineBreakStrategy lineBreakStrategy)
{
  return ENRMRenderSegmentsFromAST(node, config, /*allowTrailingMargin*/ NO, allowFontScaling,
                                   config.maxFontSizeMultiplier, lineBreakStrategy, /*blockquoteContent*/ YES);
}

// The admonition type ("note"/"tip"/…) for a node, or nil for a plain quote.
static NSString *ENRMAdmonitionTypeForNode(MarkdownASTNode *node)
{
  if (node.type != MarkdownNodeTypeAdmonition) {
    return nil;
  }
  NSString *type = node.attributes[@"admonitionType"];
  return type.length > 0 ? type : @"note";
}

static CGFloat ENRMAdmonitionIconSize(StyleConfig *config)
{
  return ceil(config.blockquoteFontSize);
}

// Bold variant of the blockquote font for the header title, respecting the
// configured family where the platform supports trait derivation.
static UIFont *ENRMAdmonitionTitleFont(StyleConfig *config)
{
  UIFont *base = config.blockquoteFont;
#if !TARGET_OS_OSX
  UIFontDescriptor *descriptor = [base.fontDescriptor
      fontDescriptorWithSymbolicTraits:(base.fontDescriptor.symbolicTraits | UIFontDescriptorTraitBold)];
  UIFont *bold = descriptor ? [UIFont fontWithDescriptor:descriptor size:base.pointSize] : nil;
  return bold ?: [UIFont boldSystemFontOfSize:base.pointSize];
#else
  NSFontDescriptor *descriptor = [base.fontDescriptor fontDescriptorWithSymbolicTraits:NSFontDescriptorTraitBold];
  NSFont *bold = descriptor ? [NSFont fontWithDescriptor:descriptor size:base.pointSize] : nil;
  return bold ?: [NSFont boldSystemFontOfSize:base.pointSize];
#endif
}

// Height of the header band (icon + title row); body sits a gap below it.
static CGFloat ENRMAdmonitionHeaderContentHeight(StyleConfig *config)
{
  return ceil(MAX(ENRMAdmonitionIconSize(config), config.blockquoteFontSize * 1.35));
}

static CGFloat ENRMAdmonitionHeaderToBodyGap(StyleConfig *config)
{
  return round(config.blockquoteFontSize * 0.4);
}

// Vertical space reserved above the body for the header (0 for a plain quote).
static CGFloat ENRMAdmonitionHeaderReservedHeight(StyleConfig *config, BOOL isAdmonition)
{
  if (!isAdmonition) {
    return 0;
  }
  return ENRMAdmonitionHeaderContentHeight(config) + ENRMAdmonitionHeaderToBodyGap(config);
}

static UIEdgeInsets ENRMBlockquoteContentInsetsForNode(StyleConfig *config, BOOL isAdmonition)
{
  CGFloat padding = config.blockquotePadding;
  CGFloat left = ceil(config.blockquoteBorderWidth + config.blockquoteGapWidth + padding);
  CGFloat top = ceil(padding + ENRMAdmonitionHeaderReservedHeight(config, isAdmonition));
  CGFloat vertical = ceil(padding);
  CGFloat right = ceil(padding);
  return UIEdgeInsetsMake(top, left, vertical, right);
}

static UIEdgeInsets ENRMBlockquoteContentInsets(StyleConfig *config)
{
  return ENRMBlockquoteContentInsetsForNode(config, NO);
}

@interface ENRMBlockquoteContainerView ()
#if !TARGET_OS_OSX
    <UIContextMenuInteractionDelegate>
#endif
// nil for a plain blockquote; the admonition type string otherwise.
@property (nonatomic, copy, nullable) NSString *admonitionType;
@property (nonatomic, copy) NSString *cachedMarkdown;
@property (nonatomic, copy) NSString *cachedPlainText;
@end

#if !TARGET_OS_OSX
@interface ENRMBlockquoteContainerView () <UITextViewDelegate, ENRMLinkContextMenuSource>
@end
#endif

@implementation ENRMBlockquoteContainerView

- (instancetype)initWithConfig:(StyleConfig *)config
{
  self = [super initWithFrame:CGRectZero];
  if (self) {
    self.config = config;
    self.contentInsets = ENRMBlockquoteContentInsets(config);
    self.allowTrailingMargin = NO;
    // Preserved prior defaults until the host overrides them at creation.
    _allowFontScaling = YES;
    _lineBreakStrategy = NSLineBreakStrategyNone;
    _dynamicProps = [[ENRMDynamicBlockProps alloc] init];
    _cachedMarkdown = @"";
    _cachedPlainText = @"";
#if !TARGET_OS_OSX
    self.contentMode = UIViewContentModeRedraw;
    UIContextMenuInteraction *contextMenu = [[UIContextMenuInteraction alloc] initWithDelegate:self];
    [self addInteraction:contextMenu];
#endif
    self.segmentViewRegistry = [self buildChildRegistry];
  }
  return self;
}

- (void)applyBlockquoteNode:(MarkdownASTNode *)node
{
  self.admonitionType = ENRMAdmonitionTypeForNode(node);
  self.contentInsets = ENRMBlockquoteContentInsetsForNode(self.config, self.admonitionType != nil);
  self.cachedMarkdown = markdownFromBlockquoteNode(node);
  self.cachedPlainText = plainTextFromASTNode(node);
  NSArray<ENRMRenderedSegment *> *rendered =
      ENRMRenderBlockquoteChildren(node, self.config, self.allowFontScaling, self.lineBreakStrategy);
  [self applySegments:rendered reset:NO];
#if !TARGET_OS_OSX
  [self setNeedsDisplay];
#else
  self.needsDisplay = YES;
#endif
}

- (void)setAccessibilityLabels:(ENRMAccessibilityLabels *)accessibilityLabels
{
  if (_accessibilityLabels == accessibilityLabels) {
    return;
  }
  _accessibilityLabels = accessibilityLabels;
  // Children created before this point (or before a labels prop change) still
  // hold the previous labels; nested quotes forward them to their own children.
  for (RCTUIView *child in self.subviews) {
    if ([child isKindOfClass:[EnrichedMarkdownInternalText class]]) {
      ((EnrichedMarkdownInternalText *)child).accessibilityLabels = accessibilityLabels;
    } else if ([child isKindOfClass:[TableContainerView class]]) {
      ((TableContainerView *)child).accessibilityLabels = accessibilityLabels;
    } else if ([child isKindOfClass:[ENRMBlockquoteContainerView class]]) {
      ((ENRMBlockquoteContainerView *)child).accessibilityLabels = accessibilityLabels;
    }
#if ENRICHED_MARKDOWN_MATH
    else if ([child isKindOfClass:[ENRMMathContainerView class]]) {
      ((ENRMMathContainerView *)child).accessibilityLabels = accessibilityLabels;
    }
#endif
  }
}

// Child registry for this quote's own content. It reuses static creators for
// every kind and, for a nested Blockquote, creates another
// ENRMBlockquoteContainerView (the recursion). Streaming is static: no
// animation, no pending-fence sync.
- (ENRMSegmentViewRegistry *)buildChildRegistry
{
  StyleConfig *config = self.config;
  __weak ENRMBlockquoteContainerView *weakSelf = self;
  NSMutableArray<ENRMSegmentViewHandler *> *handlers = [NSMutableArray array];

  [handlers
      addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindText
                    matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                      return [view isKindOfClass:[EnrichedMarkdownInternalText class]];
                    }
                    createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                      ENRMBlockquoteContainerView *strongSelf = weakSelf;
                      EnrichedMarkdownInternalText *view = [[EnrichedMarkdownInternalText alloc] initWithConfig:config];
                      view.lastElementMarginBottom = segment.textResult.lastElementMarginBottom;
                      view.accessibilityInfo = segment.textResult.accessibilityInfo;
                      view.accessibilityLabels = strongSelf.accessibilityLabels;
                      [view applyAttributedText:segment.textResult.attributedText context:segment.textResult.context];
                      if (strongSelf) {
                        [strongSelf attachLinkTapToTextView:view];
                      }
                      return view;
                    }
                    updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                      EnrichedMarkdownInternalText *textView = (EnrichedMarkdownInternalText *)view;
                      textView.lastElementMarginBottom = segment.textResult.lastElementMarginBottom;
                      textView.accessibilityInfo = segment.textResult.accessibilityInfo;
                      [textView applyAttributedText:segment.textResult.attributedText
                                            context:segment.textResult.context];
                    }]];

  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindTable
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[TableContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            TableContainerView *view = [[TableContainerView alloc] initWithConfig:config];
                            ENRMBlockquoteContainerView *strongSelf = weakSelf;
                            if (strongSelf) {
                              view.dynamicProps = strongSelf.dynamicProps;
                              view.accessibilityLabels = strongSelf.accessibilityLabels;
                              view.onLinkPress = ^(NSString *url, NSString *sourceType) {
                                ENRMBlockquoteContainerView *s = weakSelf;
                                if (s.onLinkPress && url)
                                  s.onLinkPress(url, sourceType);
                              };
                              view.onLinkLongPress = ^(NSString *url) {
                                ENRMBlockquoteContainerView *s = weakSelf;
                                if (s.onLinkLongPress && url)
                                  s.onLinkLongPress(url);
                              };
                              view.onImagePress = ^(NSString *url, NSString *altText) {
                                ENRMBlockquoteContainerView *s = weakSelf;
                                if (s.onImagePress && url)
                                  s.onImagePress(url, altText);
                              };
                            }
                            [view applyTableNode:segment.tableSegment.tableNode];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            [(TableContainerView *)view applyTableNode:segment.tableSegment.tableNode];
                          }]];

  [handlers
      addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindCodeBlock
                    matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                      return [view isKindOfClass:[ENRMCodeBlockContainerView class]];
                    }
                    createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                      ENRMCodeBlockContainerView *view = [[ENRMCodeBlockContainerView alloc] initWithConfig:config];
                      ENRMBlockquoteContainerView *strongSelf = weakSelf;
                      view.dynamicProps = strongSelf.dynamicProps;
                      view.onCopyPress = ^(NSString *code, NSString *language) {
                        ENRMBlockquoteContainerView *s = weakSelf;
                        if (s.onCopyPress)
                          s.onCopyPress(code, language);
                      };
                      view.onCodeBlockPress = ^(NSString *code, NSString *language) {
                        ENRMBlockquoteContainerView *s = weakSelf;
                        if (s.onCodeBlockPress)
                          s.onCodeBlockPress(code, language);
                      };
                      [view applyCodeBlockNode:segment.codeBlockSegment.codeBlockNode];
                      return view;
                    }
                    updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                      [(ENRMCodeBlockContainerView *)view applyCodeBlockNode:segment.codeBlockSegment.codeBlockNode];
                    }]];

  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindBlockquote
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[ENRMBlockquoteContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            ENRMBlockquoteContainerView *view =
                                [[ENRMBlockquoteContainerView alloc] initWithConfig:config];
                            view.nested = YES;
                            ENRMBlockquoteContainerView *strongSelf = weakSelf;
                            if (strongSelf) {
                              view.allowFontScaling = strongSelf.allowFontScaling;
                              view.lineBreakStrategy = strongSelf.lineBreakStrategy;
                              view.dynamicProps = strongSelf.dynamicProps;
                              view.accessibilityLabels = strongSelf.accessibilityLabels;
                              view.onCopyPress = strongSelf.onCopyPress;
                              view.onCodeBlockPress = strongSelf.onCodeBlockPress;
                              view.onImagePress = ^(NSString *url, NSString *altText) {
                                ENRMBlockquoteContainerView *s = weakSelf;
                                if (s.onImagePress && url)
                                  s.onImagePress(url, altText);
                              };
                              view.onLinkPress = ^(NSString *url, NSString *sourceType) {
                                ENRMBlockquoteContainerView *s = weakSelf;
                                if (s.onLinkPress && url)
                                  s.onLinkPress(url, sourceType);
                              };
                              view.onLinkLongPress = ^(NSString *url) {
                                ENRMBlockquoteContainerView *s = weakSelf;
                                if (s.onLinkLongPress && url)
                                  s.onLinkLongPress(url);
                              };
                            }
                            [view applyBlockquoteNode:segment.blockquoteSegment.blockquoteNode];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            [(ENRMBlockquoteContainerView *)view
                                applyBlockquoteNode:segment.blockquoteSegment.blockquoteNode];
                          }]];

#if ENRICHED_MARKDOWN_MATH
#if !TARGET_OS_OSX
  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindMath
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[ENRMMathContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            ENRMMathContainerView *view = [[ENRMMathContainerView alloc] initWithConfig:config];
                            ENRMBlockquoteContainerView *strongSelf = weakSelf;
                            view.dynamicProps = strongSelf.dynamicProps;
                            view.accessibilityLabels = strongSelf.accessibilityLabels;
                            [view applyLatex:segment.mathSegment.latex];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            [(ENRMMathContainerView *)view applyLatex:segment.mathSegment.latex];
                          }]];
#endif
#endif

#if ENRICHED_MARKDOWN_VIDEO
  __weak ENRMBlockquoteContainerView *weakBQ = self;
  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindVideo
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[ENRMVideoContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            ENRMVideoContainerView *view = [[ENRMVideoContainerView alloc] initWithConfig:config];
                            ENRMBlockquoteContainerView *bq = weakBQ;
                            if (bq) {
                              view.dynamicProps = bq.dynamicProps;
                            }
                            [view applyVideoNode:segment.videoSegment.videoNode];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            [(ENRMVideoContainerView *)view applyVideoNode:segment.videoSegment.videoNode];
                          }]];
#endif

  return [[ENRMSegmentViewRegistry alloc] initWithHandlers:handlers];
}

- (void)attachLinkTapToTextView:(EnrichedMarkdownInternalText *)view
{
  ENRMTapRecognizer *tap = [[ENRMTapRecognizer alloc] initWithTarget:self action:@selector(handleTextTap:)];
  [view.textView addGestureRecognizer:tap];
#if !TARGET_OS_OSX
  view.textView.delegate = self;
#endif
}

- (void)handleTextTap:(ENRMTapRecognizer *)recognizer
{
  ENRMPlatformTextView *textView = (ENRMPlatformTextView *)recognizer.view;
  __weak ENRMBlockquoteContainerView *weakSelf = self;
  if (ENRMHandleTapOnTextView(textView, recognizer, ^(NSString *url, NSString *sourceType) {
        ENRMBlockquoteContainerView *strongSelf = weakSelf;
        if (strongSelf.onLinkPress && url)
          strongSelf.onLinkPress(url, sourceType);
      })) {
    return;
  }

  if (self.onImagePress) {
    NSDictionary<NSString *, NSString *> *image = imageAtTapLocation(textView, recognizer);
    if (image)
      self.onImagePress(image[@"url"], image[@"altText"]);
  }
}

- (CGFloat)measureHeight:(CGFloat)maxWidth
{
  return [self computeContentHeightForWidth:MAX(maxWidth - self.contentInsets.left - self.contentInsets.right, 0)];
}

+ (CGFloat)measureHeightForBlockquoteNode:(MarkdownASTNode *)node
                                   config:(StyleConfig *)config
                                 maxWidth:(CGFloat)maxWidth
                         pointScaleFactor:(CGFloat)pointScaleFactor
                         allowFontScaling:(BOOL)allowFontScaling
                        lineBreakStrategy:(NSLineBreakStrategy)lineBreakStrategy
{
  UIEdgeInsets insets = ENRMBlockquoteContentInsetsForNode(config, ENRMAdmonitionTypeForNode(node) != nil);
  CGFloat innerWidth = MAX(maxWidth - insets.left - insets.right, 1);

  NSArray<ENRMRenderedSegment *> *rendered =
      ENRMRenderBlockquoteChildren(node, config, allowFontScaling, lineBreakStrategy);
  CGFloat childrenHeight = ENRMMeasureSegmentsHeightViewFree(
      rendered, config, innerWidth, /*allowTrailingMargin*/ NO, pointScaleFactor, ENRMWritingDirectionModeFirstStrong,
      NSWritingDirectionNatural, allowFontScaling, lineBreakStrategy);

  return childrenHeight + insets.top + insets.bottom;
}

- (void)drawRect:(CGRect)rect
{
  StyleConfig *config = self.config;
  CGFloat borderWidth = config.blockquoteBorderWidth;
  CGFloat radius = config.blockquoteBorderRadius;
  CGRect bounds = self.bounds;

  // The rounded (or plain) box outline, shared by the background fill and the accent
  // bar's clip so the bar's left corners follow the border radius.
#if !TARGET_OS_OSX
  UIBezierPath *boxPath = radius > 0 ? [UIBezierPath bezierPathWithRoundedRect:bounds cornerRadius:radius]
                                     : [UIBezierPath bezierPathWithRect:bounds];
#else
  NSBezierPath *boxPath = radius > 0 ? [NSBezierPath bezierPathWithRoundedRect:bounds xRadius:radius yRadius:radius]
                                     : [NSBezierPath bezierPathWithRect:bounds];
#endif

  // Admonitions theme the box with their per-type color; a plain quote keeps the
  // base blockquote colors.
  NSString *admonitionType = self.admonitionType;
  RCTUIColor *backgroundColor =
      admonitionType ? [config admonitionBackgroundColorForType:admonitionType] : config.blockquoteBackgroundColor;
  if (backgroundColor && backgroundColor != [RCTUIColor clearColor]) {
    [backgroundColor setFill];
    [boxPath fill];
  }

  if (borderWidth > 0) {
    RCTUIColor *borderColor =
        admonitionType ? [config admonitionColorForType:admonitionType] : config.blockquoteBorderColor;
    if (borderColor) {
      CGRect barRect = CGRectMake(0, 0, borderWidth, bounds.size.height);
      [borderColor setFill];
#if !TARGET_OS_OSX
      CGContextRef ctx = UIGraphicsGetCurrentContext();
      CGContextSaveGState(ctx);
      [boxPath addClip];
      [[UIBezierPath bezierPathWithRect:barRect] fill];
      CGContextRestoreGState(ctx);
#else
      [NSGraphicsContext saveGraphicsState];
      [boxPath addClip];
      [[NSBezierPath bezierPathWithRect:barRect] fill];
      [NSGraphicsContext restoreGraphicsState];
#endif
    }
  }

  if (admonitionType) {
    [self drawAdmonitionHeaderForType:admonitionType config:config];
  }
}

// Draws the admonition header (tinted octicon + capitalized title) in the band
// reserved at the top by the enlarged content inset. The view is flipped on
// macOS, so the y-down icon path and text draw identically on both platforms.
- (void)drawAdmonitionHeaderForType:(NSString *)type config:(StyleConfig *)config
{
  RCTUIColor *tint = [config admonitionColorForType:type];
  CGFloat padding = config.blockquotePadding;
  CGFloat leftInset = ceil(config.blockquoteBorderWidth + config.blockquoteGapWidth + padding);
  CGFloat iconSize = ENRMAdmonitionIconSize(config);
  CGFloat headerHeight = ENRMAdmonitionHeaderContentHeight(config);
  CGFloat headerTop = ceil(padding);
  CGFloat titleX = leftInset;

  CGPathRef iconPath = ENRMAdmonitionIconPath(type);
  if (iconPath) {
#if !TARGET_OS_OSX
    CGContextRef ctx = UIGraphicsGetCurrentContext();
#else
    CGContextRef ctx = [[NSGraphicsContext currentContext] CGContext];
#endif
    if (ctx) {
      CGFloat scale = iconSize / ENRMAdmonitionIconViewBox;
      CGFloat iconY = headerTop + (headerHeight - iconSize) / 2.0;
      CGContextSaveGState(ctx);
      CGContextTranslateCTM(ctx, leftInset, iconY);
      CGContextScaleCTM(ctx, scale, scale);
      CGContextAddPath(ctx, iconPath);
      [tint setFill];
      CGContextFillPath(ctx);
      CGContextRestoreGState(ctx);
    }
    titleX = leftInset + iconSize + round(iconSize * 0.4);
  }

  NSString *title = ENRMAdmonitionTitle(type);
  UIFont *titleFont = ENRMAdmonitionTitleFont(config);
  NSDictionary<NSAttributedStringKey, id> *attributes =
      @{NSFontAttributeName : titleFont, NSForegroundColorAttributeName : tint};
  NSAttributedString *attributed = [[NSAttributedString alloc] initWithString:title attributes:attributes];
  CGSize titleSize = [attributed size];
  CGFloat titleY = headerTop + (headerHeight - titleSize.height) / 2.0;
  [attributed drawAtPoint:CGPointMake(titleX, titleY)];
}

#pragma mark - Context menu

- (void)copyMarkdownToPasteboard
{
  if (_cachedMarkdown.length > 0) {
    copyStringToPasteboard(_cachedMarkdown);
  }
}

- (void)copyPlainTextToPasteboard
{
  if (_cachedPlainText.length > 0) {
    NSMutableDictionary *items = [NSMutableDictionary dictionary];
    items[kUTIPlainText] = _cachedPlainText;
    if (_cachedMarkdown.length > 0) {
      items[kUTIMarkdown] = _cachedMarkdown;
    }
    copyItemsToPasteboard(items);
  }
}

#if !TARGET_OS_OSX
- (UITextItemMenuConfiguration *)textView:(UITextView *)textView
             menuConfigurationForTextItem:(UITextItem *)textItem
                              defaultMenu:(UIMenu *)defaultMenu API_AVAILABLE(ios(17.0))
{
  return ENRMLinkMenuConfigurationForTextItem(textView, textItem, defaultMenu, self.dynamicProps.linkContextMenus,
                                              self.dynamicProps.enableLinkPreview, self.onLinkLongPress);
}

- (ENRMLinkContextMenus *)linkContextMenusForTextView:(UITextView *)textView
{
  return self.dynamicProps.linkContextMenus;
}

- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                        configurationForMenuAtLocation:(CGPoint)location
{
  // Let the leaf interaction present a configured link menu, including nested tables.
  UIView *hit = [interaction.view hitTest:location withEvent:nil];
  while (hit && hit != interaction.view) {
    CGPoint point = [interaction.view convertPoint:location toView:hit];
    NSString *url = nil;
    if ([hit isKindOfClass:[UITextView class]])
      url = linkURLAtPoint((UITextView *)hit, point);
    else if ([hit isKindOfClass:[ENRMTableIOSGridView class]])
      url = [(ENRMTableIOSGridView *)hit linkAtPoint:point].url;
    if ([self.dynamicProps.linkContextMenus hasMenuForURL:url])
      return nil;
    hit = hit.superview;
  }
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
                                           handler:^(__kindof UIAction *action) { [self copyPlainTextToPasteboard]; }];

                     UIAction *copyMarkdown =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyAsMarkdownLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.text"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyMarkdownToPasteboard]; }];

                     return [UIMenu menuWithTitle:@"" children:@[ copyPlainText, copyMarkdown ]];
                   }];
}
#endif // !TARGET_OS_OSX

#if TARGET_OS_OSX
- (BOOL)isFlipped
{
  return YES;
}

- (NSMenu *)menuForEvent:(NSEvent *)event
{
  if (!self.dynamicProps.enableBlockContextMenu) {
    return [super menuForEvent:event];
  }
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyLabel, ^{ [self copyPlainTextToPasteboard]; })];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyAsMarkdownLabel, ^{ [self copyMarkdownToPasteboard]; })];
  return menu;
}
#endif

@end
