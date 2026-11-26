#import "EnrichedMarkdown.h"
#import "ContextMenuUtils.h"
#import "ENRMAccessibilityLabels.h"
#import "ENRMAsyncRenderCoordinator.h"
#import "ENRMAtomicSize.h"
#import "ENRMImageAttachment.h"
#import "ENRMLatexErrorCoordinator.h"
#import "ENRMLinkContextMenus.h"
#import "ENRMLinkRegexProps.h"
#import "ENRMMarkdownParser.h"
#import "ENRMTailFadeInAnimator.h"
#import "ENRMTextInteractionUtils.h"
#import "ENRMTextRenderer.h"
#import "ENRMTextViewSetup.h"
#import "ENRMUIKit.h"
#import "EditMenuUtils.h"
#import "ImageRequestHeaderUtils.h"
#import "LinkContextMenuUtils.h"
#import "LinkPillContentUtils.h"

#import "ENRMFeatureFlags.h"

#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathContainerView.h"
#endif
#if ENRICHED_MARKDOWN_VIDEO
#import "ENRMVideoContainerView.h"
#endif
#import "ENRMBlockquoteContainerView.h"
#import "ENRMCodeBlockContainerView.h"
#import "ENRMDynamicBlockProps.h"
#import "ENRMSpoilerCapable.h"
#import "ENRMSpoilerOverlayView.h"
#import "ENRMSpoilerTapUtils.h"
#import "EnrichedMarkdownInternalText.h"
#import "FontScaleObserver.h"
#import "FontUtils.h"
#import "HeightUpdateUtils.h"
#import "LastElementUtils.h"
#import "LinkTapUtils.h"
#import "MarkdownASTNode.h"
#import "MarkdownAccessibilityElementBuilder.h"
#import "MarkdownExtractor.h"
#import "MeasurementCache.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "RenderedMarkdownSegment.h"
#import "RuntimeKeys.h"
#import "SegmentReconciler.h"
#import "SegmentRenderer.h"
#import "SegmentViewRegistry.h"
#import "SelectionColorUtils.h"
#import "StreamingMarkdownFilter.h"
#import "StyleConfig.h"
#import "StylePropsUtils.h"
#import "TableContainerView.h"
#import "TaskListTapUtils.h"
#import "TextViewLayoutManager.h"
#import <React/RCTUtils.h>
#import <objc/runtime.h>

#import <ReactNativeEnrichedMarkdown/EnrichedMarkdownComponentDescriptor.h>
#import <ReactNativeEnrichedMarkdown/EventEmitters.h>
#import <ReactNativeEnrichedMarkdown/Props.h>
#import <ReactNativeEnrichedMarkdown/RCTComponentViewHelpers.h>

#import "RCTFabricComponentsPlugins.h"
#import <React/RCTConversions.h>
#import <React/RCTFont.h>
#import <React/RCTI18nUtil.h>

using namespace facebook::react;

typedef NS_OPTIONS(NSUInteger, ENRMDirtyFlags) {
  ENRMDirtyNone = 0,
  ENRMDirtyRecreateSegments = 1 << 0,
  ENRMDirtyForceHeight = 1 << 1,
  ENRMDirtyRender = 1 << 2,
};

static char kENRMSegmentFadeAnimatorKey;

@interface EnrichedMarkdown () <RCTEnrichedMarkdownViewProtocol, UITextViewDelegate, ENRMImageLayoutObserver>
+ (ENRMMd4cFlags *)flagsFromProps:(const EnrichedMarkdownMd4cFlagsStruct &)props;
- (void)emitLinkPress:(NSString *)url sourceType:(NSString *)sourceType;
- (void)emitLinkLongPress:(NSString *)url;
- (void)emitLinkContextMenuItemPress:(NSString *)itemText pattern:(NSString *)pattern url:(NSString *)url;
- (void)emitImagePress:(NSString *)url altText:(NSString *)altText;
- (void)emitTaskListItemPress:(NSInteger)index checked:(BOOL)checked text:(NSString *)text;
- (void)emitCopyPress:(NSString *)code language:(NSString *)language;
- (void)emitCodeBlockPress:(NSString *)code language:(NSString *)language;
- (void)emitContextMenuItemPress:(NSString *)itemText
                    selectedText:(NSString *)selectedText
                  selectionStart:(NSUInteger)selectionStart
                    selectionEnd:(NSUInteger)selectionEnd;
@end

#if !TARGET_OS_OSX
@interface EnrichedMarkdown () <ENRMLinkContextMenuSource>
@end
#endif

@implementation EnrichedMarkdown {
  ENRMMarkdownParser *_parser;
  StyleConfig *_config;
  ENRMMd4cFlags *_md4cFlags;
  BOOL _isGFM;
  ENRMLinkRegexConfig *_linkRegex;
  ENRMLinkRegexConfig *_inlineCodeLinkRegex;
  NSString *_cachedMarkdown;
  NSString *_renderedMarkdown;
  ENRMLatexErrorCoordinator *_latexErrorCoordinator;
  NSMutableArray<RCTUIView *> *_segmentViews;
  NSMutableArray<NSNumber *> *_segmentSignatures;
  ENRMSegmentViewRegistry *_segmentViewRegistry;
  ENRMDirtyFlags _dirtyFlags;

  ENRMAsyncRenderCoordinator *_renderCoordinator;

  EnrichedMarkdownShadowNode::ConcreteState::Shared _state;
  int _heightUpdateCounter;

  FontScaleObserver *_fontScaleObserver;
  CGFloat _maxFontSizeMultiplier;

  BOOL _allowTrailingMargin;
  BOOL _selectable;
  BOOL _enableLinkPreview;
  BOOL _enableTaskListItemToggle;
  BOOL _enableImagePress;
  BOOL _streamingAnimation;
  ENRMTableStreamingMode _tableStreamingMode;
  ENRMCodeBlockStreamingMode _codeBlockStreamingMode;
  // Trailing code block whose closing fence hasn't streamed in yet, if any.
  ENRMCodeBlockSegment *_pendingCodeBlockSegment;

  size_t _renderedStyleFingerprint;
  size_t _pendingStyleFingerprint;

  ENRMLinkContextMenus *_linkContextMenus;
  NSArray<NSString *> *_contextMenuItemTexts;
  NSArray<NSString *> *_contextMenuItemIcons;
  ENRMSelectionMenuConfig _selectionMenuConfig;
  ENRMAccessibilityLabels *_accessibilityLabels;
  ENRMSelectionMenuLabels _selectionMenuLabels;

  ENRMDynamicBlockProps *_dynamicBlockProps;

  ENRMSpoilerOverlay _spoilerOverlay;

  NSLineBreakStrategy _lineBreakStrategy;

  ENRMWritingDirectionMode _writingDirectionMode;
  NSWritingDirection _resolvedLayoutDirection;

  ENRMAtomicSize _lastCommittedSize;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<EnrichedMarkdownComponentDescriptor>();
}

+ (ENRMMd4cFlags *)flagsFromProps:(const EnrichedMarkdownMd4cFlagsStruct &)props
{
  ENRMMd4cFlags *flags = [ENRMMd4cFlags defaultFlags];
  flags.underline = props.underline;
  flags.superscript = props.superscript;
  flags.subscript = props.subscript;
  flags.latexMath = props.latexMath;
  flags.highlight = props.highlight;
  flags.hardSoftBreaks = props.hardSoftBreaks;
  flags.preserveBlankLines = props.preserveBlankLines;
  flags.admonitions = props.admonitions;
  return flags;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const EnrichedMarkdownProps>();
    _props = defaultProps;

    self.backgroundColor = [RCTUIColor clearColor];
    _parser = [[ENRMMarkdownParser alloc] init];
    _md4cFlags = [EnrichedMarkdown flagsFromProps:defaultProps->md4cFlags];
    _isGFM = defaultProps->isGFM;
    _linkRegex = ENRMLinkRegexConfigFromProps(defaultProps->linkRecognition.text);
    _inlineCodeLinkRegex = ENRMLinkRegexConfigFromProps(defaultProps->linkRecognition.inlineCode);
    _segmentViews = [NSMutableArray array];
    _segmentSignatures = [NSMutableArray array];
    __weak __typeof(self) weakLatexSelf = self;
    _latexErrorCoordinator =
        [[ENRMLatexErrorCoordinator alloc] initWithEmit:^BOOL(NSString *source, NSString *message, BOOL displayMode) {
          __typeof(self) strongSelf = weakLatexSelf;
          if (!strongSelf)
            return NO;
          auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(strongSelf->_eventEmitter);
          if (!emitter)
            return NO;
          emitter->onLatexError({
              .source = std::string(source.UTF8String ?: ""),
              .message = std::string(message.UTF8String ?: ""),
              .displayMode = displayMode ? true : false,
          });
          return YES;
        }];
    _dirtyFlags = ENRMDirtyNone;
    [self configureSegmentViewRegistry];

    _renderCoordinator =
        [[ENRMAsyncRenderCoordinator alloc] initWithQueueLabel:"com.swmansion.enriched.markdown.container.render"];

    _maxFontSizeMultiplier = 0;
    _allowTrailingMargin = NO;
    _selectable = YES;
    _enableLinkPreview = YES;
    _enableTaskListItemToggle = YES;
    _enableImagePress = NO;
    _dynamicBlockProps = [[ENRMDynamicBlockProps alloc] init];
    _linkContextMenus = [[ENRMLinkContextMenus alloc] init];
    __weak EnrichedMarkdown *weakMenuSelf = self;
    _linkContextMenus.onPress = ^(NSString *url, NSString *pattern, NSString *itemText) {
      [weakMenuSelf emitLinkContextMenuItemPress:itemText pattern:pattern url:url];
    };
    _dynamicBlockProps.linkContextMenus = _linkContextMenus;
    _streamingAnimation = NO;
    _tableStreamingMode = ENRMTableStreamingModeProgressive;
    _codeBlockStreamingMode = ENRMCodeBlockStreamingModeProgressive;
    _selectionMenuConfig = (ENRMSelectionMenuConfig){.copyAsMarkdown = YES, .copyImageURL = YES};
    _lineBreakStrategy = NSLineBreakStrategyNone;
    _writingDirectionMode = ENRMWritingDirectionModeFirstStrong;
    _resolvedLayoutDirection =
        [[RCTI18nUtil sharedInstance] isRTL] ? NSWritingDirectionRightToLeft : NSWritingDirectionLeftToRight;

    _fontScaleObserver = [[FontScaleObserver alloc] init];
    __weak EnrichedMarkdown *weakSelf = self;
    _fontScaleObserver.onChange = ^{
      EnrichedMarkdown *strongSelf = weakSelf;
      if (!strongSelf)
        return;
      if (strongSelf->_config != nil) {
        [strongSelf->_config setFontScaleMultiplier:strongSelf->_fontScaleObserver.effectiveFontScale];
      }
      if (strongSelf->_cachedMarkdown != nil && strongSelf->_cachedMarkdown.length > 0) {
        strongSelf->_dirtyFlags |= ENRMDirtyRecreateSegments | ENRMDirtyForceHeight;
        [strongSelf renderMarkdownContent:strongSelf->_cachedMarkdown];
      }
    };
  }
  return self;
}

- (void)configureSegmentViewRegistry
{
  __weak EnrichedMarkdown *weakSelf = self;
  NSMutableArray<ENRMSegmentViewHandler *> *handlers = [NSMutableArray array];

  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindText
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[EnrichedMarkdownInternalText class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (!strongSelf) {
                              return [[RCTUIView alloc] init];
                            }

                            EnrichedMarkdownInternalText *view =
                                [strongSelf createTextViewForRenderedSegment:segment.textResult];
                            [strongSelf animateTextView:view fromTailStart:0];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (strongSelf) {
                              [strongSelf updateTextView:(EnrichedMarkdownInternalText *)view
                                     withRenderedSegment:segment.textResult];
                            }
                          }]];

  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindTable
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[TableContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (!strongSelf) {
                              return [[RCTUIView alloc] init];
                            }

                            TableContainerView *view = [strongSelf createTableViewForSegment:segment.tableSegment];
                            [strongSelf animateBlockViewIfNeeded:view];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (strongSelf) {
                              [strongSelf updateTableView:(TableContainerView *)view withSegment:segment.tableSegment];
                            }
                          }]];

#if ENRICHED_MARKDOWN_MATH
  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindMath
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[ENRMMathContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (!strongSelf) {
                              return [[RCTUIView alloc] init];
                            }

                            ENRMMathContainerView *view =
                                [strongSelf createMathViewForSegment:(ENRMMathSegment *)segment.mathSegment];
                            [strongSelf animateBlockViewIfNeeded:view];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            [(ENRMMathContainerView *)view applyLatex:((ENRMMathSegment *)segment.mathSegment).latex];
                          }]];
#endif

  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindCodeBlock
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[ENRMCodeBlockContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (!strongSelf) {
                              return [[RCTUIView alloc] init];
                            }

                            ENRMCodeBlockContainerView *view =
                                [strongSelf createCodeBlockViewForSegment:segment.codeBlockSegment];
                            [strongSelf animateBlockViewIfNeeded:view];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            ENRMCodeBlockContainerView *codeBlockView = (ENRMCodeBlockContainerView *)view;
                            codeBlockView.pending =
                                strongSelf && segment.codeBlockSegment == strongSelf->_pendingCodeBlockSegment;
                            [codeBlockView applyCodeBlockNode:segment.codeBlockSegment.codeBlockNode];
                          }]];

  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindBlockquote
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[ENRMBlockquoteContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (!strongSelf) {
                              return [[RCTUIView alloc] init];
                            }

                            ENRMBlockquoteContainerView *view =
                                [strongSelf createBlockquoteViewForSegment:segment.blockquoteSegment];
                            [strongSelf animateBlockViewIfNeeded:view];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            [(ENRMBlockquoteContainerView *)view
                                applyBlockquoteNode:segment.blockquoteSegment.blockquoteNode];
                          }]];

#if ENRICHED_MARKDOWN_VIDEO
  [handlers addObject:[ENRMSegmentViewHandler handlerWithKind:ENRMSegmentKindVideo
                          matchesView:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
                            return [view isKindOfClass:[ENRMVideoContainerView class]];
                          }
                          createView:^RCTUIView *(ENRMRenderedSegment *segment) {
                            EnrichedMarkdown *strongSelf = weakSelf;
                            if (!strongSelf) {
                              return [[RCTUIView alloc] init];
                            }

                            ENRMVideoContainerView *view =
                                [[ENRMVideoContainerView alloc] initWithConfig:strongSelf->_config];
                            view.dynamicProps = strongSelf->_dynamicBlockProps;
                            [view applyVideoNode:segment.videoSegment.videoNode];
                            [strongSelf animateBlockViewIfNeeded:view];
                            return view;
                          }
                          updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
                            ENRMVideoContainerView *videoView = (ENRMVideoContainerView *)view;
                            [videoView applyVideoNode:segment.videoSegment.videoNode];
                            [videoView reapplyStyle];
                          }]];
#endif

  _segmentViewRegistry = [[ENRMSegmentViewRegistry alloc] initWithHandlers:handlers];
}

- (ENRMBlockquoteContainerView *)createBlockquoteViewForSegment:(ENRMBlockquoteSegment *)blockquoteSegment
{
  ENRMBlockquoteContainerView *view = [[ENRMBlockquoteContainerView alloc] initWithConfig:_config];
  view.allowFontScaling = _fontScaleObserver.allowFontScaling;
  view.lineBreakStrategy = _lineBreakStrategy;
  view.dynamicProps = _dynamicBlockProps;
  view.accessibilityLabels = _accessibilityLabels;

  __weak EnrichedMarkdown *weakSelf = self;
  view.onCopyPress = ^(NSString *code, NSString *language) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf)
      [strongSelf emitCopyPress:code language:language];
  };
  view.onCodeBlockPress = ^(NSString *code, NSString *language) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf)
      [strongSelf emitCodeBlockPress:code language:language];
  };
  view.onLinkPress = ^(NSString *url, NSString *sourceType) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf && url)
      [strongSelf emitLinkPress:url sourceType:sourceType];
  };
  view.onLinkLongPress = ^(NSString *url) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf && url)
      [strongSelf emitLinkLongPress:url];
  };

  view.onImagePress = ^(NSString *url, NSString *altText) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf && strongSelf->_enableImagePress && url)
      [strongSelf emitImagePress:url altText:altText];
  };

  [view applyBlockquoteNode:blockquoteSegment.blockquoteNode];
  return view;
}

/// The box the segments actually live in: the component frame inset by the
/// `containerStyle` border and padding (`LayoutMetrics::getContentFrame`).
///
/// Yoga hands `measureContent` an available size that already excludes those
/// insets and then adds them back to the frame it commits, so laying the
/// segments out against `self.bounds` would stack them over the padding and
/// across the border while the space Yoga reserved for the content stays blank
/// at the bottom. Unlike `EnrichedMarkdownText`, the segments are attached to
/// the component view itself rather than to `contentView`, so nothing applies
/// the insets for us.
///
/// Taken from `_layoutMetrics` rather than recomputed off `self.bounds`:
/// `prepareForRecycle` resets the metrics but leaves the bounds behind, so the
/// two do not always agree. The box is empty both before the first layout
/// metrics arrive and when the insets consume the whole component width; neither
/// may fall back to `self.bounds`, which is the padded border box the segments
/// must not be drawn across, so an over-constrained box clamps to zero and
/// callers skip laying out at all.
- (CGRect)contentBounds
{
  CGRect box = RCTCGRectFromRect(_layoutMetrics.getContentFrame());
  box.size.width = MAX(box.size.width, 0);
  box.size.height = MAX(box.size.height, 0);
  return box;
}

- (CGSize)computeSegmentLayoutForWidth:(CGFloat)width applyFrames:(BOOL)applyFrames
{
  if (_segmentViews.count == 0)
    return CGSizeZero;

  if (applyFrames) {
    CGFloat overhang = MAX(_config.tableHorizontalOverflow, 0);
    BOOL needsOverhang = NO;
    if (overhang > 0) {
      for (RCTUIView *seg in _segmentViews) {
        if ([seg isKindOfClass:[TableContainerView class]]) {
          needsOverhang = YES;
          break;
        }
      }
    }
#if TARGET_OS_OSX
    BOOL isClipping = self.layer.masksToBounds;
    if (isClipping && needsOverhang)
      self.layer.masksToBounds = NO;
    else if (!isClipping && !needsOverhang)
      self.layer.masksToBounds = YES;
#else
    if (self.clipsToBounds != !needsOverhang)
      self.clipsToBounds = !needsOverhang;
#endif
  }

  __block CGFloat yOffset = 0.0;
  __block CGFloat maxContentWidth = 0.0;
  const NSUInteger lastIndex = _segmentViews.count - 1;
  // Frames are stacked in the component's own coordinate space, so the content
  // origin (containerStyle border + padding) shifts every segment. yOffset stays
  // content-relative because it doubles as the measured content height.
  const CGPoint contentOrigin = applyFrames ? [self contentBounds].origin : CGPointZero;

  [_segmentViews enumerateObjectsUsingBlock:^(RCTUIView *segment, NSUInteger i, BOOL *stop) {
    const BOOL isLast = (i == lastIndex);
    const BOOL shouldAddBottomMargin = (!isLast || _allowTrailingMargin);

    CGFloat segmentHeight = 0;
    const BOOL isTable = [segment isKindOfClass:[TableContainerView class]];

    if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
      EnrichedMarkdownInternalText *textView = (EnrichedMarkdownInternalText *)segment;
      textView.allowTrailingMargin = shouldAddBottomMargin;
      CGSize textSize = [textView measureSize:width];
      segmentHeight = textSize.height;
      maxContentWidth = MAX(maxContentWidth, textSize.width);

    } else if (isTable) {
      yOffset += _config.tableMarginTop;
      segmentHeight = [(TableContainerView *)segment measureHeight:width];
      maxContentWidth = width;
    }
#if ENRICHED_MARKDOWN_MATH
    else if ([segment isKindOfClass:[ENRMMathContainerView class]]) {
      yOffset += _config.mathMarginTop;
      segmentHeight = [(ENRMMathContainerView *)segment measureHeight:width];
      maxContentWidth = width;
    }
#endif
    else if ([segment isKindOfClass:[ENRMCodeBlockContainerView class]]) {
      yOffset += _config.codeBlockMarginTop;
      segmentHeight = [(ENRMCodeBlockContainerView *)segment measureHeight:width];
      maxContentWidth = width;
    } else if ([segment isKindOfClass:[ENRMBlockquoteContainerView class]]) {
      yOffset += _config.blockquoteMarginTop;
      segmentHeight = [(ENRMBlockquoteContainerView *)segment measureHeight:width];
      maxContentWidth = width;
    }
#if ENRICHED_MARKDOWN_VIDEO
    else if ([segment isKindOfClass:[ENRMVideoContainerView class]]) {
      yOffset += _config.videoMarginTop;
      segmentHeight = [(ENRMVideoContainerView *)segment measureHeight:width];
      maxContentWidth = width;
    }
#endif

    if (applyFrames) {
      CGFloat segmentX = contentOrigin.x;
      CGFloat segmentWidth = width;
      if (isTable) {
        CGFloat overhang = MAX(_config.tableHorizontalOverflow, 0);
        if (overhang > 0) {
          segmentX = contentOrigin.x - overhang;
          segmentWidth = width + overhang * 2;
        }
      }
      CGRect segmentFrame = CGRectMake(segmentX, contentOrigin.y + yOffset, segmentWidth, segmentHeight);
      segment.frame = segmentFrame;
#if TARGET_OS_OSX
      if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
        EnrichedMarkdownInternalText *textSeg = (EnrichedMarkdownInternalText *)segment;
        textSeg.textView.frame = segment.bounds;
        textSeg.textView.textContainer.size = CGSizeMake(width, CGFLOAT_MAX);
        [textSeg.textView.layoutManager ensureLayoutForTextContainer:textSeg.textView.textContainer];
        ENRMSetNeedsDisplay(textSeg.textView);
      }
#endif
    }

    yOffset += segmentHeight;

    if ([segment isKindOfClass:[TableContainerView class]] && shouldAddBottomMargin) {
      yOffset += _config.tableMarginBottom;
    }
#if ENRICHED_MARKDOWN_MATH
    else if ([segment isKindOfClass:[ENRMMathContainerView class]] && shouldAddBottomMargin) {
      yOffset += _config.mathMarginBottom;
    }
#endif
    else if ([segment isKindOfClass:[ENRMCodeBlockContainerView class]] && shouldAddBottomMargin) {
      yOffset += _config.codeBlockMarginBottom;
    } else if ([segment isKindOfClass:[ENRMBlockquoteContainerView class]] && shouldAddBottomMargin) {
      yOffset += _config.blockquoteMarginBottom;
    }
#if ENRICHED_MARKDOWN_VIDEO
    else if ([segment isKindOfClass:[ENRMVideoContainerView class]] && shouldAddBottomMargin) {
      yOffset += _config.videoMarginBottom;
    }
#endif
  }];

  return CGSizeMake(maxContentWidth, yOffset);
}

- (CGSize)measureSize:(CGFloat)maxWidth
{
  CGFloat defaultHeight = UIFontLineHeight([UIFont systemFontOfSize:16.0]);
  CGSize contentSize = [self computeSegmentLayoutForWidth:maxWidth applyFrames:NO];
  if (contentSize.height == 0)
    return CGSizeMake(maxWidth, defaultHeight);

  CGFloat scale = RCTScreenScale();
  CGFloat measuredWidth = MIN(ceil(contentSize.width * scale) / scale, maxWidth);
  CGFloat measuredHeight = ceil(contentSize.height * scale) / scale;
  return CGSizeMake(measuredWidth, measuredHeight);
}

- (CGSize)lastCommittedLayoutSize
{
  return _lastCommittedSize.load();
}

- (BOOL)hasRenderedMarkdown:(NSString *)markdown
{
  return _renderedMarkdown != nil && [_renderedMarkdown isEqualToString:markdown];
}

- (BOOL)hasRenderedWithStyleFingerprint:(size_t)fingerprint
{
  return _renderedStyleFingerprint == fingerprint;
}

- (BOOL)renderedSegmentsChangeTopology:(NSArray<ENRMRenderedSegment *> *)renderedSegments
{
  if (renderedSegments.count != _segmentViews.count) {
    return YES;
  }

  for (NSUInteger index = 0; index < renderedSegments.count; index++) {
    if (![_segmentViewRegistry view:_segmentViews[index] matchesSegment:renderedSegments[index]]) {
      return YES;
    }
  }

  return NO;
}

- (void)updateState:(const facebook::react::State::Shared &)state
           oldState:(const facebook::react::State::Shared &)oldState
{
  _state = std::static_pointer_cast<const EnrichedMarkdownShadowNode::ConcreteState>(state);

  if (oldState == nullptr) {
    [self requestHeightUpdate];
  }
}

/// Publishes the committed size to the streaming fast path's mailbox, and picks
/// up the Yoga-resolved direction inherited from any ancestor `direction` style.
/// In FirstStrong mode the direction feeds the neutral-paragraph fallback, so a
/// change requires segment recreation.
///
/// The mailbox holds a content size, not the border box: `measureContent`
/// returns it straight to Yoga, which adds the `containerStyle` insets back on
/// top of whatever it gets, so storing `frame.size` would double-count them.
- (void)updateLayoutMetrics:(const LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const LayoutMetrics &)oldLayoutMetrics
{
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:oldLayoutMetrics];

  const auto contentSize = layoutMetrics.getContentFrame().size;
  _lastCommittedSize.store(CGSizeMake(contentSize.width, contentSize.height));

  NSWritingDirection resolved = _resolvedLayoutDirection;
  if (layoutMetrics.layoutDirection == LayoutDirection::RightToLeft) {
    resolved = NSWritingDirectionRightToLeft;
  } else if (layoutMetrics.layoutDirection == LayoutDirection::LeftToRight) {
    resolved = NSWritingDirectionLeftToRight;
  }

  if (resolved != _resolvedLayoutDirection) {
    _resolvedLayoutDirection = resolved;
    [self pushWritingDirectionToTableSegments];
    if (_writingDirectionMode == ENRMWritingDirectionModeFirstStrong && _cachedMarkdown.length > 0) {
      _dirtyFlags |= ENRMDirtyRecreateSegments | ENRMDirtyForceHeight;
      [self renderMarkdownContent:_cachedMarkdown];
    }
  }
}

- (void)pushWritingDirectionToTableSegments
{
  for (RCTUIView *segment in _segmentViews) {
    if ([segment isKindOfClass:[TableContainerView class]]) {
      TableContainerView *tableView = (TableContainerView *)segment;
      tableView.writingDirectionMode = _writingDirectionMode;
      tableView.resolvedLayoutDirection = _resolvedLayoutDirection;
    }
  }
}

- (void)pushAccessibilityLabelsToSegments
{
  for (RCTUIView *segment in _segmentViews) {
    if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
      ((EnrichedMarkdownInternalText *)segment).accessibilityLabels = _accessibilityLabels;
    } else if ([segment isKindOfClass:[TableContainerView class]]) {
      ((TableContainerView *)segment).accessibilityLabels = _accessibilityLabels;
    } else if ([segment isKindOfClass:[ENRMBlockquoteContainerView class]]) {
      ((ENRMBlockquoteContainerView *)segment).accessibilityLabels = _accessibilityLabels;
    }
#if ENRICHED_MARKDOWN_MATH
    else if ([segment isKindOfClass:[ENRMMathContainerView class]]) {
      ((ENRMMathContainerView *)segment).accessibilityLabels = _accessibilityLabels;
    }
#endif
  }
}

- (void)requestHeightUpdate
{
  ENRMRequestHeightUpdate<EnrichedMarkdownState>(_state, _heightUpdateCounter, self);
}

// A block image in one of the text segments resolved its box height after
// loading (maxHeight/aspectRatio sizing). The shadow node measured — and
// cached — this markdown with the pre-load fallback height, so drop those
// entries, re-stack segments, and re-measure.
- (void)imageAttachmentDidResolveLayout
{
  if (_renderedMarkdown.length > 0) {
    MeasurementCache::shared().removeMatchingMarkdown(std::string(_renderedMarkdown.UTF8String));
  }

  CGRect contentBounds = [self contentBounds];
  if (contentBounds.size.width > 0) {
    [self setNeedsLayout];
    CGSize measured = [self measureSize:contentBounds.size.width];
    if (needsHeightUpdate(measured, contentBounds)) {
      [self requestHeightUpdate];
    }
  }
}

- (void)renderMarkdownContent:(NSString *)markdownString
{
  if (_renderCoordinator.blockAsyncRender)
    return;

  _cachedMarkdown = [markdownString copy];

  StyleConfig *config = [_config copy];
  ENRMMarkdownParser *parser = _parser;
  ENRMMd4cFlags *md4cFlags = [_md4cFlags copy];
  BOOL isGFM = _isGFM;
  ENRMLinkRegexConfig *linkRegex = _linkRegex;
  ENRMLinkRegexConfig *inlineCodeLinkRegex = _inlineCodeLinkRegex;

  BOOL allowFontScaling = _fontScaleObserver.allowFontScaling;
  CGFloat maxFontSizeMultiplier = _maxFontSizeMultiplier;
  BOOL allowTrailingMargin = _allowTrailingMargin;
  BOOL streamingAnimation = _streamingAnimation;
  ENRMTableStreamingMode tableStreamingMode = _tableStreamingMode;
  ENRMCodeBlockStreamingMode codeBlockStreamingMode = _codeBlockStreamingMode;
  NSLineBreakStrategy lineBreakStrategy = _lineBreakStrategy;
  ENRMWritingDirectionMode writingDirectionMode = _writingDirectionMode;
  NSWritingDirection resolvedLayoutDirection = _resolvedLayoutDirection;

  __block NSArray<ENRMRenderedSegment *> *renderedSegments = nil;
  __block NSString *renderableMarkdown = nil;
  __block BOOL endsInsideOpenCodeFence = NO;

  [_renderCoordinator
      scheduleRender:^BOOL {
        renderableMarkdown = streamingAnimation
                                 ? ENRMRenderableMarkdownForStreaming(markdownString, tableStreamingMode,
                                                                      codeBlockStreamingMode, &endsInsideOpenCodeFence)
                                 : markdownString;

        if (renderableMarkdown.length == 0) {
          renderedSegments = @[];
          return YES;
        }

        MarkdownASTNode *ast = [parser parseMarkdown:renderableMarkdown
                                               flags:md4cFlags
                                               isGFM:isGFM
                                           linkRegex:linkRegex
                                 inlineCodeLinkRegex:inlineCodeLinkRegex];
        if (!ast)
          return NO;

        renderedSegments = ENRMRenderSegmentsFromAST(ast, config, allowTrailingMargin, allowFontScaling,
                                                     maxFontSizeMultiplier, lineBreakStrategy,
                                                     /*blockquoteContent*/ NO);
        for (ENRMRenderedSegment *segment in renderedSegments) {
          if (segment.kind == ENRMSegmentKindText && segment.textResult) {
            ENRMApplyWritingDirectionMode(segment.textResult.attributedText, writingDirectionMode,
                                          resolvedLayoutDirection);
          }
        }
        return YES;
      }
      apply:^{
        self->_renderedStyleFingerprint = self->_pendingStyleFingerprint;
        [self applyRenderedSegments:renderedSegments
                   renderedMarkdown:renderableMarkdown
            endsInsideOpenCodeFence:endsInsideOpenCodeFence];
      }];
}

- (NSArray *)parseAndRenderSegments:(NSString *)markdownString
{
  MarkdownASTNode *ast = [_parser parseMarkdown:markdownString
                                          flags:_md4cFlags
                                          isGFM:_isGFM
                                      linkRegex:_linkRegex
                            inlineCodeLinkRegex:_inlineCodeLinkRegex];
  if (!ast) {
    return nil;
  }

  NSArray<ENRMRenderedSegment *> *segments =
      ENRMRenderSegmentsFromAST(ast, _config, _allowTrailingMargin, _fontScaleObserver.allowFontScaling,
                                _maxFontSizeMultiplier, _lineBreakStrategy, /*blockquoteContent*/ NO);
  for (ENRMRenderedSegment *segment in segments) {
    if (segment.kind == ENRMSegmentKindText && segment.textResult) {
      ENRMApplyWritingDirectionMode(segment.textResult.attributedText, _writingDirectionMode, _resolvedLayoutDirection);
    }
  }
  return segments;
}

/// Synchronous rendering for mock view measurement (no UI updates needed).
- (void)renderMarkdownSynchronously:(NSString *)markdownString
{
  if (!markdownString || markdownString.length == 0) {
    return;
  }

  for (RCTUIView *view in _segmentViews) {
    [view removeFromSuperview];
  }
  [_segmentViews removeAllObjects];
  [_segmentSignatures removeAllObjects];

  _renderCoordinator.blockAsyncRender = YES;
  _cachedMarkdown = [markdownString copy];
  BOOL endsInsideOpenCodeFence = NO;
  NSString *renderableMarkdown =
      _streamingAnimation ? ENRMRenderableMarkdownForStreaming(markdownString, _tableStreamingMode,
                                                               _codeBlockStreamingMode, &endsInsideOpenCodeFence)
                          : markdownString;
  _renderedMarkdown = [renderableMarkdown copy];
  _renderedStyleFingerprint = _pendingStyleFingerprint;

  if (renderableMarkdown.length == 0) {
    return;
  }

  NSArray *renderedSegments = [self parseAndRenderSegments:renderableMarkdown];
  if (!renderedSegments) {
    return;
  }

  [self updatePendingCodeBlockSegment:endsInsideOpenCodeFence segments:renderedSegments];

  for (ENRMRenderedSegment *segment in renderedSegments) {
    RCTUIView *view = [_segmentViewRegistry createViewForSegment:segment];
    [_segmentViews addObject:view];
    [_segmentSignatures addObject:@(segment.signature)];
    [self addSubview:view];
  }
}

- (void)updatePendingCodeBlockSegment:(BOOL)endsInsideOpenCodeFence segments:(NSArray<ENRMRenderedSegment *> *)segments
{
  _pendingCodeBlockSegment = nil;
  if (!_streamingAnimation || !endsInsideOpenCodeFence) {
    return;
  }
  ENRMRenderedSegment *last = segments.lastObject;
  if (last.kind == ENRMSegmentKindCodeBlock) {
    _pendingCodeBlockSegment = last.codeBlockSegment;
  }
}

- (void)applyRenderedSegments:(NSArray *)renderedSegments
             renderedMarkdown:(NSString *)renderedMarkdown
      endsInsideOpenCodeFence:(BOOL)endsInsideOpenCodeFence
{
  _renderedMarkdown = [renderedMarkdown copy];
  [self updatePendingCodeBlockSegment:endsInsideOpenCodeFence segments:renderedSegments];
  BOOL segmentTopologyChanged = _streamingAnimation && [self renderedSegmentsChangeTopology:renderedSegments];

  ENRMSegmentReconciliationResult *result = [ENRMSegmentReconciler reconcileCurrentViews:_segmentViews
      currentSignatures:_segmentSignatures
      renderedSegments:renderedSegments
      reset:(_dirtyFlags & ENRMDirtyRecreateSegments) != 0
      createView:^RCTUIView *(ENRMRenderedSegment *segment) {
        return [self->_segmentViewRegistry createViewForSegment:segment];
      }
      updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) {
        [self->_segmentViewRegistry updateView:view withSegment:segment];
      }
      attachView:^(RCTUIView *view) { [self addSubview:view]; }
      removeView:^(RCTUIView *view) { [view removeFromSuperview]; }
      matchesKind:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
        return [self->_segmentViewRegistry view:view matchesSegment:segment];
      }];
  BOOL forceHeightUpdate = (_dirtyFlags & ENRMDirtyForceHeight) != 0;
  _dirtyFlags = ENRMDirtyNone;

  _segmentViews = result.views;
  _segmentSignatures = result.signatures;

  // A just-closed block has unchanged content, so the reconciler reuses it
  // without an update; sync pending here to trigger its deferred highlight.
  [_segmentViews enumerateObjectsUsingBlock:^(RCTUIView *segment, NSUInteger i, BOOL *stop) {
    if ([segment isKindOfClass:[ENRMCodeBlockContainerView class]]) {
      ((ENRMCodeBlockContainerView *)segment).pending =
          self->_pendingCodeBlockSegment != nil && i == self->_segmentViews.count - 1;
    }
  }];

  CGRect contentBounds = [self contentBounds];
  if (contentBounds.size.width > 0) {
    [self setNeedsLayout];

    if (forceHeightUpdate || segmentTopologyChanged) {
      [self computeSegmentLayoutForWidth:contentBounds.size.width applyFrames:YES];
      [self layoutIfNeeded];
      [self requestHeightUpdate];
    } else {
      CGSize measured = [self measureSize:contentBounds.size.width];
      if (needsHeightUpdate(measured, contentBounds)) {
        [self requestHeightUpdate];
      }
    }
  }
}

- (void)configureTextView:(EnrichedMarkdownInternalText *)view withRenderedSegment:(ENRMRenderResult *)segment
{
  view.spoilerOverlay = _spoilerOverlay;
  view.allowTrailingMargin = _allowTrailingMargin;
  view.lastElementMarginBottom = segment.lastElementMarginBottom;
  view.accessibilityInfo = segment.accessibilityInfo;
  view.accessibilityLabels = _accessibilityLabels;
  view.textView.selectable = _selectable;
  [_latexErrorCoordinator wireReporters:segment.context.mathReporters];
  [view applyAttributedText:segment.attributedText context:segment.context];

  const auto &selectionProps = *std::static_pointer_cast<EnrichedMarkdownProps const>(self->_props);
  ENRMApplySelectionColor(view.textView, selectionProps.selectionColor);
}

- (EnrichedMarkdownInternalText *)createTextViewForRenderedSegment:(ENRMRenderResult *)segment
{
  EnrichedMarkdownInternalText *view = [[EnrichedMarkdownInternalText alloc] initWithConfig:_config];
  [self configureTextView:view withRenderedSegment:segment];

  ENRMTapRecognizer *tapRecognizer = [[ENRMTapRecognizer alloc] initWithTarget:self action:@selector(textTapped:)];
  [view.textView addGestureRecognizer:tapRecognizer];

#if !TARGET_OS_OSX
  view.textView.delegate = self;
#else
  __weak EnrichedMarkdown *weakSelf = self;
  [view setContextMenuProvider:^NSMenu *_Nullable(NSMenu *baseMenu, NSTextView *textView) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (!strongSelf) {
      return baseMenu;
    }
    NSString *segmentMarkdown = extractMarkdownFromAttributedString(textView.textStorage, textView.selectedRange);
    NSArray<NSMenuItem *> *customItems = ENRMBuildContextMenuItems(
        strongSelf->_contextMenuItemTexts, strongSelf->_contextMenuItemIcons, textView,
        ^(NSString *itemText, NSString *selectedText, NSUInteger selectionStart, NSUInteger selectionEnd) {
          [strongSelf emitContextMenuItemPress:itemText
                                  selectedText:selectedText
                                selectionStart:selectionStart
                                  selectionEnd:selectionEnd];
        });
    return buildEditMenuForSelection(textView.textStorage, textView.selectedRange, segmentMarkdown, strongSelf->_config,
                                     @[ baseMenu ], customItems, strongSelf -> _selectionMenuConfig);
  }];
#endif

  return view;
}

- (TableContainerView *)createTableViewForSegment:(ENRMTableSegment *)tableSegment
{
  TableContainerView *tableView = [[TableContainerView alloc] initWithConfig:_config];

  tableView.allowFontScaling = _fontScaleObserver.allowFontScaling;
  tableView.maxFontSizeMultiplier = _maxFontSizeMultiplier;
  tableView.enableLinkPreview = _enableLinkPreview;
  tableView.dynamicProps = _dynamicBlockProps;
  tableView.writingDirectionMode = _writingDirectionMode;
  tableView.resolvedLayoutDirection = _resolvedLayoutDirection;
  tableView.accessibilityLabels = _accessibilityLabels;

  __weak EnrichedMarkdown *weakSelf = self;

  tableView.onLinkPress = ^(NSString *url, NSString *sourceType) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf && url)
      [strongSelf emitLinkPress:url sourceType:sourceType];
  };

  tableView.onLinkLongPress = ^(NSString *url) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf && url)
      [strongSelf emitLinkLongPress:url];
  };

  tableView.onImagePress = ^(NSString *url, NSString *altText) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf && strongSelf->_enableImagePress && url)
      [strongSelf emitImagePress:url altText:altText];
  };

  [tableView applyTableNode:tableSegment.tableNode];

  return tableView;
}

- (void)updateTableView:(TableContainerView *)view withSegment:(ENRMTableSegment *)tableSegment
{
  view.writingDirectionMode = _writingDirectionMode;
  view.resolvedLayoutDirection = _resolvedLayoutDirection;
  NSUInteger previousRowCount = view.rowCount;
  [view applyTableNode:tableSegment.tableNode];

  if (_streamingAnimation && !ENRMShouldReduceMotion()) {
    [view animateNewRowsFromPreviousCount:previousRowCount duration:0.20];
  }
}

#if ENRICHED_MARKDOWN_MATH
- (ENRMMathContainerView *)createMathViewForSegment:(ENRMMathSegment *)mathSegment
{
  ENRMMathContainerView *mathView = [[ENRMMathContainerView alloc] initWithConfig:_config];
  mathView.dynamicProps = _dynamicBlockProps;
  mathView.accessibilityLabels = _accessibilityLabels;
  ENRMLatexErrorCoordinator *coordinator = _latexErrorCoordinator;
  mathView.onLatexError = ^(NSString *source, NSString *message, BOOL displayMode) {
    [coordinator reportSource:source message:message displayMode:displayMode];
  };
  [mathView applyLatex:mathSegment.latex];
  return mathView;
}
#endif

- (ENRMCodeBlockContainerView *)createCodeBlockViewForSegment:(ENRMCodeBlockSegment *)codeBlockSegment
{
  ENRMCodeBlockContainerView *codeBlockView = [[ENRMCodeBlockContainerView alloc] initWithConfig:_config];
  codeBlockView.dynamicProps = _dynamicBlockProps;

  __weak EnrichedMarkdown *weakSelf = self;
  codeBlockView.onCopyPress = ^(NSString *code, NSString *language) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf)
      [strongSelf emitCopyPress:code language:language];
  };
  codeBlockView.onCodeBlockPress = ^(NSString *code, NSString *language) {
    EnrichedMarkdown *strongSelf = weakSelf;
    if (strongSelf)
      [strongSelf emitCodeBlockPress:code language:language];
  };

  codeBlockView.pending = codeBlockSegment == _pendingCodeBlockSegment;
  [codeBlockView applyCodeBlockNode:codeBlockSegment.codeBlockNode];
  return codeBlockView;
}

- (void)animateBlockViewIfNeeded:(RCTUIView *)view
{
  if (!_streamingAnimation)
    return;

#if !TARGET_OS_OSX
  if (ENRMShouldReduceMotion()) {
    return;
  }
  view.alpha = 0.0;
  [UIView animateWithDuration:0.20 animations:^{ view.alpha = 1.0; }];
#endif
}

- (void)animateTextView:(EnrichedMarkdownInternalText *)view fromTailStart:(NSUInteger)tailStart
{
  if (!_streamingAnimation)
    return;

  ENRMTailFadeInAnimator *animator = objc_getAssociatedObject(view.textView, &kENRMSegmentFadeAnimatorKey);
  if (!animator) {
    animator = [[ENRMTailFadeInAnimator alloc] initWithTextView:view.textView];
    objc_setAssociatedObject(view.textView, &kENRMSegmentFadeAnimatorKey, animator, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }

  [animator animateFrom:tailStart to:ENRMGetAttributedText(view.textView).length];
}

- (void)updateTextView:(EnrichedMarkdownInternalText *)view withRenderedSegment:(ENRMRenderResult *)segment
{
  NSUInteger tailStart = ENRMGetAttributedText(view.textView).length;
  [self configureTextView:view withRenderedSegment:segment];
  [self animateTextView:view fromTailStart:tailStart];
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  CGFloat contentWidth = [self contentBounds].size.width;
  if (contentWidth > 0) {
    [self computeSegmentLayoutForWidth:contentWidth applyFrames:YES];
  }
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<EnrichedMarkdownProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<EnrichedMarkdownProps const>(props);

  BOOL markdownChanged = oldViewProps.markdown != newViewProps.markdown;
  if (markdownChanged) {
    _dirtyFlags |= ENRMDirtyRender;
  }

  if (_config == nil) {
    _config = [[StyleConfig alloc] init];
    [_config setFontScaleMultiplier:_fontScaleObserver.effectiveFontScale];
  }

  if (applyMarkdownStyleToConfig(_config, newViewProps.markdownStyle, oldViewProps.markdownStyle)) {
    _dirtyFlags |= ENRMDirtyForceHeight | ENRMDirtyRender;
    if (!markdownChanged) {
      _dirtyFlags |= ENRMDirtyRecreateSegments;
    }
  }

  if (ENRMImageRequestHeadersChanged(oldViewProps.imageRequestHeaders, newViewProps.imageRequestHeaders)) {
    [_config setImageRequestHeaders:ENRMImageRequestHeadersFromProps(newViewProps.imageRequestHeaders)];
    _dirtyFlags |= ENRMDirtyRender;
    if (!markdownChanged) {
      _dirtyFlags |= ENRMDirtyRecreateSegments;
    }
  }

  // Pill labels change layout, so treat new content like a style change.
  if (ENRMLinkPillContentChanged(oldViewProps.linkPillContent, newViewProps.linkPillContent)) {
    [_config setLinkPillContent:ENRMLinkPillContentFromProps(newViewProps.linkPillContent)];
    _dirtyFlags |= ENRMDirtyRender;
    if (!markdownChanged) {
      _dirtyFlags |= ENRMDirtyRecreateSegments;
    }
  }

  _selectable = newViewProps.selectable;

  for (RCTUIView *segment in _segmentViews) {
    if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
      EnrichedMarkdownInternalText *textSegment = (EnrichedMarkdownInternalText *)segment;
      if (textSegment.textView.selectable != newViewProps.selectable) {
        textSegment.textView.selectable = newViewProps.selectable;
      }
    }
  }

  if (newViewProps.allowFontScaling != oldViewProps.allowFontScaling) {
    _fontScaleObserver.allowFontScaling = newViewProps.allowFontScaling;
    if (_config != nil) {
      [_config setFontScaleMultiplier:_fontScaleObserver.effectiveFontScale];
    }
    _dirtyFlags |= ENRMDirtyRecreateSegments | ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  if (newViewProps.maxFontSizeMultiplier != oldViewProps.maxFontSizeMultiplier) {
    _maxFontSizeMultiplier = newViewProps.maxFontSizeMultiplier;
    if (_config != nil) {
      [_config setMaxFontSizeMultiplier:_maxFontSizeMultiplier];
    }
    _dirtyFlags |= ENRMDirtyRecreateSegments | ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  if (newViewProps.allowTrailingMargin != oldViewProps.allowTrailingMargin) {
    _allowTrailingMargin = newViewProps.allowTrailingMargin;
    _dirtyFlags |= ENRMDirtyRecreateSegments | ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  if (!ENRMLinkRegexPropsEqual(oldViewProps.linkRecognition.text, newViewProps.linkRecognition.text)) {
    _linkRegex = ENRMLinkRegexConfigFromProps(newViewProps.linkRecognition.text);
    _dirtyFlags |= ENRMDirtyRender;
    _dirtyFlags |= ENRMDirtyForceHeight;
  }
  if (!ENRMLinkRegexPropsEqual(oldViewProps.linkRecognition.inlineCode, newViewProps.linkRecognition.inlineCode)) {
    _inlineCodeLinkRegex = ENRMLinkRegexConfigFromProps(newViewProps.linkRecognition.inlineCode);
    _dirtyFlags |= ENRMDirtyRender;
    _dirtyFlags |= ENRMDirtyForceHeight;
  }

  if (newViewProps.md4cFlags.underline != oldViewProps.md4cFlags.underline ||
      newViewProps.md4cFlags.superscript != oldViewProps.md4cFlags.superscript ||
      newViewProps.md4cFlags.subscript != oldViewProps.md4cFlags.subscript ||
      newViewProps.md4cFlags.latexMath != oldViewProps.md4cFlags.latexMath ||
      newViewProps.md4cFlags.highlight != oldViewProps.md4cFlags.highlight ||
      newViewProps.md4cFlags.hardSoftBreaks != oldViewProps.md4cFlags.hardSoftBreaks ||
      newViewProps.md4cFlags.preserveBlankLines != oldViewProps.md4cFlags.preserveBlankLines ||
      newViewProps.md4cFlags.admonitions != oldViewProps.md4cFlags.admonitions) {
    _md4cFlags = [EnrichedMarkdown flagsFromProps:newViewProps.md4cFlags];
    _dirtyFlags |= ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  if (newViewProps.isGFM != oldViewProps.isGFM) {
    _isGFM = newViewProps.isGFM;
    _dirtyFlags |= ENRMDirtyRecreateSegments | ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  _enableLinkPreview = newViewProps.enableLinkPreview;
  _enableTaskListItemToggle = newViewProps.enableTaskListItemToggle;
  _enableImagePress = newViewProps.enableImagePress;

  // Block gates: mutate the shared box in place. Every existing and future block
  // view reads it live at use-time, so no push into segments is needed.
  _dynamicBlockProps.enableLinkPreview = newViewProps.enableLinkPreview;
  _dynamicBlockProps.enableBlockContextMenu = newViewProps.enableBlockContextMenu;
  _dynamicBlockProps.enableCodeBlockPress = newViewProps.enableCodeBlockPress;

  if (newViewProps.streamingAnimation != oldViewProps.streamingAnimation) {
    _streamingAnimation = newViewProps.streamingAnimation;
    _dirtyFlags |= ENRMDirtyForceHeight | ENRMDirtyRender;
    if (!_streamingAnimation) {
      for (RCTUIView *segment in _segmentViews) {
        if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
          ENRMTailFadeInAnimator *animator = objc_getAssociatedObject(
              ((EnrichedMarkdownInternalText *)segment).textView, &kENRMSegmentFadeAnimatorKey);
          [animator cancel];
          objc_setAssociatedObject(((EnrichedMarkdownInternalText *)segment).textView, &kENRMSegmentFadeAnimatorKey,
                                   nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
      }
    }
  }

  if (newViewProps.streamingConfig.tableMode != oldViewProps.streamingConfig.tableMode) {
    NSString *tableModeStr = [[NSString alloc] initWithUTF8String:newViewProps.streamingConfig.tableMode.c_str()];
    _tableStreamingMode =
        [tableModeStr isEqualToString:@"hidden"] ? ENRMTableStreamingModeHidden : ENRMTableStreamingModeProgressive;
    _dirtyFlags |= ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  if (newViewProps.streamingConfig.codeBlockMode != oldViewProps.streamingConfig.codeBlockMode) {
    NSString *codeBlockModeStr =
        [[NSString alloc] initWithUTF8String:newViewProps.streamingConfig.codeBlockMode.c_str()];
    _codeBlockStreamingMode = [codeBlockModeStr isEqualToString:@"hidden"] ? ENRMCodeBlockStreamingModeHidden
                                                                           : ENRMCodeBlockStreamingModeProgressive;
    _dirtyFlags |= ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  if (ENRMLinkContextMenuItemsChanged(oldViewProps.linkContextMenuItems, newViewProps.linkContextMenuItems)) {
    _linkContextMenus.entries = ENRMLinkContextMenuEntriesFromProps(newViewProps.linkContextMenuItems);
  }

  if (ENRMContextMenuItemsChanged(oldViewProps.contextMenuItems, newViewProps.contextMenuItems)) {
    _contextMenuItemTexts = ENRMContextMenuTextsFromItems(newViewProps.contextMenuItems);
    _contextMenuItemIcons = ENRMContextMenuIconsFromItems(newViewProps.contextMenuItems);
  }

  _selectionMenuLabels = ENRMParseSelectionMenuLabels(newViewProps.selectionMenuConfig);
  _selectionMenuConfig =
      ENRMBuildSelectionMenuConfig(_selectionMenuLabels, newViewProps.selectionMenuConfig.copyAsMarkdown,
                                   newViewProps.selectionMenuConfig.copyImageUrl);
  // Block menu labels live in the shared box; block views read them live at
  // menu-open. (_selectionMenuLabels also feeds the text selection menu above.)
  _dynamicBlockProps.copyLabel = _selectionMenuLabels.copyLabel;
  _dynamicBlockProps.copyAsMarkdownLabel = _selectionMenuLabels.copyAsMarkdownLabel;

  if (ENRMAccessibilityLabelsChanged(oldViewProps.accessibilityLabels, newViewProps.accessibilityLabels)) {
    _accessibilityLabels = [[ENRMAccessibilityLabels alloc] init];
    _accessibilityLabels.bulletPoint =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.list.bulletPoint.c_str()];
    _accessibilityLabels.nestedBulletPoint =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.list.nestedBulletPoint.c_str()];
    _accessibilityLabels.orderedItem =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.list.orderedItem.c_str()];
    _accessibilityLabels.nestedOrderedItem =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.list.nestedOrderedItem.c_str()];
    _accessibilityLabels.blockquote =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.blockquote.quote.c_str()];
    _accessibilityLabels.nestedBlockquote =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.blockquote.nestedQuote.c_str()];
    _accessibilityLabels.tableRow =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.table.row.c_str()];
    _accessibilityLabels.mathEquation =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.math.equation.c_str()];
    _accessibilityLabels.rotorHeadings =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.rotor.headings.c_str()];
    _accessibilityLabels.rotorLinks =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.rotor.links.c_str()];
    _accessibilityLabels.rotorImages =
        [[NSString alloc] initWithUTF8String:newViewProps.accessibilityLabels.rotor.images.c_str()];
    [self pushAccessibilityLabelsToSegments];
  }

  if (newViewProps.spoilerOverlay != oldViewProps.spoilerOverlay) {
    NSString *modeStr = [[NSString alloc] initWithUTF8String:newViewProps.spoilerOverlay.c_str()];
    _spoilerOverlay = ENRMSpoilerOverlayFromString(modeStr);
    for (RCTUIView *segment in _segmentViews) {
      if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
        ((EnrichedMarkdownInternalText *)segment).spoilerOverlay = _spoilerOverlay;
      }
    }
  }

  if (newViewProps.selectionColor != oldViewProps.selectionColor) {
    for (RCTUIView *segment in _segmentViews) {
      if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
        ENRMPlatformTextView *tv = ((EnrichedMarkdownInternalText *)segment).textView;
        ENRMApplySelectionColor(tv, newViewProps.selectionColor);
      }
    }
  }

  if (newViewProps.lineBreakStrategyIOS != oldViewProps.lineBreakStrategyIOS) {
    NSString *strategy = [[NSString alloc] initWithUTF8String:newViewProps.lineBreakStrategyIOS.c_str()];
    _lineBreakStrategy = ENRMResolveLineBreakStrategy(strategy);
    _dirtyFlags |= ENRMDirtyForceHeight | ENRMDirtyRender;
  }

  if (newViewProps.writingDirection != oldViewProps.writingDirection) {
    NSString *value = [[NSString alloc] initWithUTF8String:newViewProps.writingDirection.c_str()];
    _writingDirectionMode = ENRMResolveWritingDirectionMode(value);
    _dirtyFlags |= ENRMDirtyRecreateSegments | ENRMDirtyForceHeight | ENRMDirtyRender;
    [self pushWritingDirectionToTableSegments];
  }

  if (_dirtyFlags & ENRMDirtyRender) {
    _pendingStyleFingerprint =
        computeStyleFingerprint(newViewProps.markdownStyle) ^ std::hash<bool>{}(newViewProps.allowTrailingMargin);
    NSString *markdownString = [[NSString alloc] initWithUTF8String:newViewProps.markdown.c_str()];
    [self renderMarkdownContent:markdownString];
    _dirtyFlags &= ~ENRMDirtyRender;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];

  if (self.window && _renderedMarkdown != nil) {
    for (RCTUIView *segment in _segmentViews) {
      if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
        EnrichedMarkdownInternalText *textSegment = (EnrichedMarkdownInternalText *)segment;
        ENRMRefreshTextViewAfterWindowAttach(textSegment.textView, textSegment.bounds);
      }
    }

    CGRect contentBounds = [self contentBounds];
    if (contentBounds.size.width > 0) {
      CGSize measured = [self measureSize:contentBounds.size.width];
      if (needsHeightUpdate(measured, contentBounds)) {
        [self requestHeightUpdate];
      }
    }
  }
}

- (void)prepareForRecycle
{
  const auto resetProps = std::make_shared<const EnrichedMarkdownProps>();
  _props = resetProps;
  [_renderCoordinator invalidate];

  for (RCTUIView *segment in _segmentViews) {
    if ([segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
      EnrichedMarkdownInternalText *textSegment = (EnrichedMarkdownInternalText *)segment;
      ENRMTailFadeInAnimator *animator = objc_getAssociatedObject(textSegment.textView, &kENRMSegmentFadeAnimatorKey);
      [animator cancel];
      objc_setAssociatedObject(textSegment.textView, &kENRMSegmentFadeAnimatorKey, nil,
                               OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    [segment removeFromSuperview];
  }
  [_segmentViews removeAllObjects];
  [_segmentSignatures removeAllObjects];

  _cachedMarkdown = nil;
  _renderedMarkdown = nil;
  _config = nil;
  _md4cFlags = [EnrichedMarkdown flagsFromProps:resetProps->md4cFlags];
  _isGFM = resetProps->isGFM;
  _linkRegex = ENRMLinkRegexConfigFromProps(resetProps->linkRecognition.text);
  _inlineCodeLinkRegex = ENRMLinkRegexConfigFromProps(resetProps->linkRecognition.inlineCode);
  _maxFontSizeMultiplier = 0;
  _allowTrailingMargin = NO;
  _streamingAnimation = NO;
  _tableStreamingMode = ENRMTableStreamingModeProgressive;
  _codeBlockStreamingMode = ENRMCodeBlockStreamingModeProgressive;
  _pendingCodeBlockSegment = nil;
  _lineBreakStrategy = NSLineBreakStrategyNone;
  _writingDirectionMode = ENRMWritingDirectionModeFirstStrong;
  _renderedStyleFingerprint = 0;
  _pendingStyleFingerprint = 0;
  _linkContextMenus.entries = @[];
  _contextMenuItemTexts = nil;
  _contextMenuItemIcons = nil;
  _fontScaleObserver.allowFontScaling = resetProps->allowFontScaling;
  _accessibilityLabels = nil;
  _spoilerOverlay =
      ENRMSpoilerOverlayFromString([[NSString alloc] initWithUTF8String:resetProps->spoilerOverlay.c_str()]);
  _dirtyFlags = ENRMDirtyNone;

  [super prepareForRecycle];
}

Class<RCTComponentViewProtocol> EnrichedMarkdownCls(void)
{
  return EnrichedMarkdown.class;
}

#if !TARGET_OS_OSX
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event
{
  if ([super pointInside:point withEvent:event]) {
    return YES;
  }

  for (RCTUIView *segment in _segmentViews) {
    if (CGRectContainsPoint(segment.frame, point)) {
      return YES;
    }
  }

  return NO;
}
#endif

- (facebook::react::SharedTouchEventEmitter)touchEventEmitterAtPoint:(CGPoint)point
{
  for (RCTUIView *segment in _segmentViews) {
    if ([segment isKindOfClass:[TableContainerView class]]) {
      CGPoint segmentPoint = [self convertPoint:point toView:segment];
#if !TARGET_OS_OSX
      if ([segment pointInside:segmentPoint withEvent:nil]) {
        return nil;
      }
#else
      if (CGRectContainsPoint(segment.bounds, segmentPoint)) {
        return nil;
      }
#endif
    }

    if (![segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
      continue;
    }
    EnrichedMarkdownInternalText *textSegment = (EnrichedMarkdownInternalText *)segment;
    CGPoint segmentPoint = [self convertPoint:point toView:textSegment.textView];
#if !TARGET_OS_OSX
    BOOL isInsideView = [textSegment.textView pointInside:segmentPoint withEvent:nil];
#else
    BOOL isInsideView = CGRectContainsPoint(textSegment.textView.bounds, segmentPoint);
#endif
    if (isInsideView) {
      if (isPointOnInteractiveElement(textSegment.textView, segmentPoint, _enableImagePress, NO)) {
        return nil;
      }
      break;
    }
  }

  return [super touchEventEmitterAtPoint:point];
}

#if TARGET_OS_OSX
- (void)mouseDown:(NSEvent *)event
{
  for (RCTUIView *segment in _segmentViews) {
    if (![segment isKindOfClass:[EnrichedMarkdownInternalText class]]) {
      continue;
    }
    ENRMPlatformTextView *tv = ((EnrichedMarkdownInternalText *)segment).textView;
    if (tv.selectedRange.length > 0) {
      tv.selectedRange = NSMakeRange(0, 0);
    }
  }
  [super mouseDown:event];
}
#endif

- (void)emitLinkPress:(NSString *)url sourceType:(NSString *)sourceType
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter)
    emitter->onLinkPress({.url = std::string(url.UTF8String), .sourceType = std::string(sourceType.UTF8String)});
}

- (void)emitImagePress:(NSString *)url altText:(NSString *)altText
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter)
    emitter->onImagePress({.url = std::string(url.UTF8String ?: ""), .altText = std::string(altText.UTF8String ?: "")});
}

- (void)emitLinkLongPress:(NSString *)url
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter)
    emitter->onLinkLongPress({.url = std::string(url.UTF8String)});
}

- (void)emitLinkContextMenuItemPress:(NSString *)itemText pattern:(NSString *)pattern url:(NSString *)url
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter) {
    emitter->onLinkContextMenuItemPress({.url = std::string(url.UTF8String),
                                         .pattern = std::string(pattern.UTF8String),
                                         .itemText = std::string(itemText.UTF8String)});
  }
}

- (void)emitTaskListItemPress:(NSInteger)index checked:(BOOL)checked text:(NSString *)text
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter)
    emitter->onTaskListItemPress({.index = (int)index, .checked = checked, .text = std::string(text.UTF8String ?: "")});
}

- (void)emitCopyPress:(NSString *)code language:(NSString *)language
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter)
    emitter->onCopyPress(
        {.code = std::string(code.UTF8String ?: ""), .language = std::string(language.UTF8String ?: "")});
}

- (void)emitCodeBlockPress:(NSString *)code language:(NSString *)language
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter)
    emitter->onCodeBlockPress(
        {.code = std::string(code.UTF8String ?: ""), .language = std::string(language.UTF8String ?: "")});
}

- (void)emitContextMenuItemPress:(NSString *)itemText
                    selectedText:(NSString *)selectedText
                  selectionStart:(NSUInteger)selectionStart
                    selectionEnd:(NSUInteger)selectionEnd
{
  auto emitter = std::static_pointer_cast<EnrichedMarkdownEventEmitter const>(_eventEmitter);
  if (emitter)
    emitter->onContextMenuItemPress({
        .itemText = std::string(itemText.UTF8String),
        .selectedText = std::string(selectedText.UTF8String),
        .selectionStart = (int)selectionStart,
        .selectionEnd = (int)selectionEnd,
    });
}

- (void)updateEventEmitter:(const facebook::react::EventEmitter::Shared &)eventEmitter
{
  [super updateEventEmitter:eventEmitter];
  [_latexErrorCoordinator flushPending];
}

- (void)textTapped:(ENRMTapRecognizer *)recognizer
{
  ENRMPlatformTextView *textView = (ENRMPlatformTextView *)recognizer.view;

  if (_enableTaskListItemToggle &&
      handleTaskListTapWithSharedLogic(
          textView, recognizer, &self->_cachedMarkdown, self->_config,
          ^(NSInteger index, BOOL checked, NSString *itemText) {
            [self emitTaskListItemPress:index checked:checked text:itemText];
          },
          ^(NSString *updatedMarkdown) { [self renderMarkdownContent:updatedMarkdown]; })) {
    return;
  }

  for (RCTUIView *segment in _segmentViews) {
    if ([segment conformsToProtocol:@protocol(ENRMSpoilerCapable)]) {
      id<ENRMSpoilerCapable> spoilerSegment = (id<ENRMSpoilerCapable>)segment;
      if (spoilerSegment.textView == textView) {
        if (handleSpoilerTap(textView, recognizer, spoilerSegment.spoilerManager))
          return;
        break;
      }
    }
  }

  if (ENRMHandleTapOnTextView(textView, recognizer, ^(NSString *url, NSString *sourceType) {
        [self emitLinkPress:url sourceType:sourceType];
      })) {
    return;
  }

  if (_enableImagePress) {
    NSDictionary<NSString *, NSString *> *image = imageAtTapLocation(textView, recognizer);
    if (image) {
      [self emitImagePress:image[@"url"] altText:image[@"altText"]];
    }
  }
}

// TODO: Remove API_AVAILABLE(ios(16.0)) guard when the minimum iOS deployment target in RN is bumped to 16.
#if !TARGET_OS_OSX
- (UIMenu *)textView:(UITextView *)textView
    editMenuForTextInRange:(NSRange)range
          suggestedActions:(NSArray<UIMenuElement *> *)suggestedActions API_AVAILABLE(ios(16.0))
{
  __weak EnrichedMarkdown *weakSelf = self;
  ENRMContextMenuPressHandler handler =
      ^(NSString *itemText, NSString *selectedText, NSUInteger selectionStart, NSUInteger selectionEnd) {
        EnrichedMarkdown *strongSelf = weakSelf;
        if (strongSelf)
          [strongSelf emitContextMenuItemPress:itemText
                                  selectedText:selectedText
                                selectionStart:selectionStart
                                  selectionEnd:selectionEnd];
      };
  NSMutableArray<UIAction *> *customActions =
      ENRMBuildContextMenuActions(_contextMenuItemTexts, _contextMenuItemIcons, textView, range, handler);

  NSString *segmentMarkdown = extractMarkdownFromAttributedString(textView.attributedText, range);
  return buildEditMenuForSelection(textView.attributedText, range, segmentMarkdown, _config, suggestedActions,
                                   customActions, _selectionMenuConfig);
}

- (UITextItemMenuConfiguration *)textView:(UITextView *)textView
             menuConfigurationForTextItem:(UITextItem *)textItem
                              defaultMenu:(UIMenu *)defaultMenu API_AVAILABLE(ios(17.0))
{
  __weak EnrichedMarkdown *weakSelf = self;
  return ENRMLinkMenuConfigurationForTextItem(textView, textItem, defaultMenu, _linkContextMenus, _enableLinkPreview,
                                              ^(NSString *url) { [weakSelf emitLinkLongPress:url]; });
}

- (ENRMLinkContextMenus *)linkContextMenusForTextView:(UITextView *)textView
{
  return _linkContextMenus;
}

- (BOOL)textView:(UITextView *)textView
    shouldInteractWithURL:(NSURL *)URL
                  inRange:(NSRange)characterRange
              interaction:(UITextItemInteraction)interaction
{
  if (interaction != UITextItemInteractionPresentActions) {
    return YES;
  }

  NSString *urlString = linkURLAtRange(textView, characterRange);

  // A link with a menu is presented by the iOS 17 callback above and must not be vetoed here.
  if ([_linkContextMenus hasMenuForURL:urlString])
    return YES;

  if (!urlString || _enableLinkPreview) {
    return YES;
  }

  [self emitLinkLongPress:urlString];
  return NO;
}
#endif

- (BOOL)isAccessibilityElement
{
  return NO;
}

- (NSArray *)accessibilityElements
{
  return _segmentViews;
}

- (NSInteger)accessibilityElementCount
{
  return [self accessibilityElements].count;
}

- (id)accessibilityElementAtIndex:(NSInteger)index
{
  NSArray *elements = [self accessibilityElements];
  if (index < 0 || index >= (NSInteger)elements.count) {
    return nil;
  }
  return elements[index];
}

- (NSInteger)indexOfAccessibilityElement:(id)element
{
  return [[self accessibilityElements] indexOfObject:element];
}

#if !TARGET_OS_OSX
- (NSArray<UIAccessibilityCustomRotor *> *)accessibilityCustomRotors
{
  return [MarkdownAccessibilityElementBuilder buildRotorsFromElements:[self accessibilityElements]
                                                               labels:_accessibilityLabels];
}
#endif

@end
