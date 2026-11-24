#import "ENRMContainerNodeView.h"
#import "ENRMBlockquoteContainerView.h"
#import "ENRMCodeBlockContainerView.h"
#import "ENRMFeatureFlags.h"
#import "EnrichedMarkdownInternalText.h"
#import "SegmentReconciler.h"
#import "TableContainerView.h"
#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathContainerView.h"
#endif
#if ENRICHED_MARKDOWN_VIDEO
#import "ENRMVideoContainerView.h"
#endif

@implementation ENRMContainerNodeView {
  NSMutableArray<RCTUIView *> *_segmentViews;
  NSMutableArray<NSNumber *> *_segmentSignatures;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    _segmentViews = [NSMutableArray array];
    _segmentSignatures = [NSMutableArray array];
    _contentInsets = UIEdgeInsetsZero;
    _allowTrailingMargin = NO;
    self.backgroundColor = [RCTUIColor clearColor];
#if !TARGET_OS_OSX
    self.contentMode = UIViewContentModeRedraw;
#endif
  }
  return self;
}

#if TARGET_OS_OSX
- (BOOL)isFlipped
{
  return YES;
}
#endif

- (void)applySegments:(NSArray<ENRMRenderedSegment *> *)renderedSegments reset:(BOOL)reset
{
  ENRMSegmentViewRegistry *registry = _segmentViewRegistry;
  ENRMSegmentReconciliationResult *result = [ENRMSegmentReconciler reconcileCurrentViews:_segmentViews
      currentSignatures:_segmentSignatures
      renderedSegments:renderedSegments
      reset:reset
      createView:^RCTUIView *(ENRMRenderedSegment *segment) { return [registry createViewForSegment:segment]; }
      updateView:^(RCTUIView *view, ENRMRenderedSegment *segment) { [registry updateView:view withSegment:segment]; }
      attachView:^(RCTUIView *view) { [self addSubview:view]; }
      removeView:^(RCTUIView *view) { [view removeFromSuperview]; }
      matchesKind:^BOOL(RCTUIView *view, ENRMRenderedSegment *segment) {
        return [registry view:view matchesSegment:segment];
      }];

  _segmentViews = result.views;
  _segmentSignatures = result.signatures;

#if !TARGET_OS_OSX
  [self setNeedsLayout];
#else
  self.needsLayout = YES;
#endif
}

- (CGFloat)marginTopForView:(RCTUIView *)view
{
  if ([view isKindOfClass:[TableContainerView class]]) {
    return _config.tableMarginTop;
  }
  if ([view isKindOfClass:[ENRMCodeBlockContainerView class]]) {
    return _config.codeBlockMarginTop;
  }
  if ([view isKindOfClass:[ENRMBlockquoteContainerView class]]) {
    // A quote laid out inside another quote is nested and carries no margin; the
    // outermost quote's margin is applied by the root host instead.
    return ((ENRMBlockquoteContainerView *)view).nested ? 0 : _config.blockquoteMarginTop;
  }
#if ENRICHED_MARKDOWN_MATH
  if ([view isKindOfClass:[ENRMMathContainerView class]]) {
    return _config.mathMarginTop;
  }
#endif
#if ENRICHED_MARKDOWN_VIDEO
  if ([view isKindOfClass:[ENRMVideoContainerView class]]) {
    return _config.videoMarginTop;
  }
#endif
  return 0;
}

- (CGFloat)marginBottomForView:(RCTUIView *)view
{
  if ([view isKindOfClass:[TableContainerView class]]) {
    return _config.tableMarginBottom;
  }
  if ([view isKindOfClass:[ENRMCodeBlockContainerView class]]) {
    return _config.codeBlockMarginBottom;
  }
  if ([view isKindOfClass:[ENRMBlockquoteContainerView class]]) {
    return ((ENRMBlockquoteContainerView *)view).nested ? 0 : _config.blockquoteMarginBottom;
  }
#if ENRICHED_MARKDOWN_MATH
  if ([view isKindOfClass:[ENRMMathContainerView class]]) {
    return _config.mathMarginBottom;
  }
#endif
#if ENRICHED_MARKDOWN_VIDEO
  if ([view isKindOfClass:[ENRMVideoContainerView class]]) {
    return _config.videoMarginBottom;
  }
#endif
  return 0;
}

- (CGFloat)heightForView:(RCTUIView *)view atWidth:(CGFloat)width shouldAddBottomMargin:(BOOL)shouldAddBottomMargin
{
  if ([view isKindOfClass:[EnrichedMarkdownInternalText class]]) {
    EnrichedMarkdownInternalText *textView = (EnrichedMarkdownInternalText *)view;
    textView.allowTrailingMargin = shouldAddBottomMargin;
    return [textView measureSize:width].height;
  }
  if ([view isKindOfClass:[TableContainerView class]]) {
    return [(TableContainerView *)view measureHeight:width];
  }
  if ([view isKindOfClass:[ENRMCodeBlockContainerView class]]) {
    return [(ENRMCodeBlockContainerView *)view measureHeight:width];
  }
  if ([view isKindOfClass:[ENRMBlockquoteContainerView class]]) {
    return [(ENRMBlockquoteContainerView *)view measureHeight:width];
  }
#if ENRICHED_MARKDOWN_MATH
  if ([view isKindOfClass:[ENRMMathContainerView class]]) {
    return [(ENRMMathContainerView *)view measureHeight:width];
  }
#endif
#if ENRICHED_MARKDOWN_VIDEO
  if ([view isKindOfClass:[ENRMVideoContainerView class]]) {
    return [(ENRMVideoContainerView *)view measureHeight:width];
  }
#endif
  return 0;
}

// Mirrors the root's computeSegmentLayoutForWidth: (text via measureSize:,
// block kinds via measureHeight: plus their config margins), but confined to the
// inner content rect defined by contentInsets so a subclass can pad its children.
- (CGSize)layoutChildrenForOuterWidth:(CGFloat)outerWidth applyFrames:(BOOL)applyFrames
{
  CGFloat contentWidth = MAX(outerWidth - _contentInsets.left - _contentInsets.right, 0);
  if (_segmentViews.count == 0 || contentWidth <= 0) {
    return CGSizeMake(0, _contentInsets.top + _contentInsets.bottom);
  }

  CGFloat yOffset = _contentInsets.top;
  const NSUInteger lastIndex = _segmentViews.count - 1;

  for (NSUInteger i = 0; i < _segmentViews.count; i++) {
    RCTUIView *view = _segmentViews[i];
    const BOOL isLast = (i == lastIndex);
    const BOOL shouldAddBottomMargin = (!isLast || _allowTrailingMargin);

    yOffset += [self marginTopForView:view];
    CGFloat height = [self heightForView:view atWidth:contentWidth shouldAddBottomMargin:shouldAddBottomMargin];

    if (applyFrames) {
      view.frame = CGRectMake(_contentInsets.left, yOffset, contentWidth, height);
    }

    yOffset += height;
    if (shouldAddBottomMargin) {
      yOffset += [self marginBottomForView:view];
    }
  }

  yOffset += _contentInsets.bottom;
  return CGSizeMake(outerWidth, yOffset);
}

- (CGFloat)computeContentHeightForWidth:(CGFloat)contentWidth
{
  return [self layoutChildrenForOuterWidth:contentWidth + _contentInsets.left + _contentInsets.right applyFrames:NO]
      .height;
}

#if !TARGET_OS_OSX
- (void)layoutSubviews
{
  [super layoutSubviews];
  [self layoutChildrenForOuterWidth:self.bounds.size.width applyFrames:YES];
}
#else
- (void)layout
{
  [super layout];
  [self layoutChildrenForOuterWidth:self.bounds.size.width applyFrames:YES];
}
#endif

@end
