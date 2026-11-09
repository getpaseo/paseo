#import <React/RCTComponentViewFactory.h>
#import <React/RCTCustomPullToRefreshViewProtocol.h>
#import <React/RCTScrollViewComponentView.h>
#import <React/RCTViewComponentView.h>
#import <react/renderer/components/scrollview/ScrollViewProps.h>
#import <react/renderer/components/scrollview/ScrollViewShadowNode.h>

using namespace facebook::react;

/**
 * React Native's scroll view with three maintainVisibleContentPosition corrections.
 *
 * An anchor removed by the mount it anchors. React Native picks the anchor before the mount and
 * moves the offset by the anchor's movement after it. When the mount removes that view, its frame
 * after the mount no longer describes the content, and the offset jumps by an unrelated amount.
 * Android keeps a removed view's last frame, so it keeps the offset. This class keeps the offset on
 * iOS too.
 * The chat timeline hits this when it stops following its end: the same mount removes the end pin
 * and opens the disclosure the reader tapped.
 * React Native 0.88 skips the adjustment for a removed anchor
 * (https://github.com/react/react-native/pull/57294). Its view-registry tag check matches the check
 * here; its superview check also skips anchors that removeClippedSubviews detached
 * (https://github.com/react/react-native/issues/58910). Remove this part once the installed React
 * Native includes the tag check.
 *
 * The chat timeline's end pin during a drag. While the timeline follows its end, a zero-height view
 * at the bottom of the content (native ID "paseo-end-pin", packages/app/src/agent-stream/
 * native-end-pin.tsx) is the anchor, so every line that mounts scrolls the content by its height.
 * A drag owns the offset from the frame it begins, and JS removes the pin only a round trip later.
 * While the user drags, a mount anchored on the pin keeps the offset, so the line grows below the
 * rows under the finger. Android's PaseoScrollView does the same.
 *
 * A shrink at the end. A mount that shrinks the content sets the smaller contentSize, and UIKit
 * clamps contentOffset to the new end. React Native then adds the anchor's movement to the clamped
 * offset, so the shrink is applied twice and the viewport lands above the content it kept.
 * The chat timeline hits this when a finished turn folds while the end pin follows the latest row.
 * https://github.com/react/react-native/issues/58578
 * Remove once https://github.com/react/react-native/pull/58695 ships; it keeps the pre-mount
 * offset and clamps after the adjustment, as this class does.
 */
@interface PaseoScrollViewComponentView : RCTScrollViewComponentView
@end

@implementation PaseoScrollViewComponentView {
  CGPoint _offsetBeforeMount;
  __weak UIView *_anchorBeforeMount;
  NSInteger _anchorTagBeforeMount;
}

// Replaces React Native's class for the ScrollView component. The factory looks a component up the
// first time it mounts, so the registration has to come before the first surface.
+ (void)load
{
  [[RCTComponentViewFactory currentComponentViewFactory] registerComponentViewClass:self];
}

// iOS 26 blurs a scroll view's edges and places the blur in the scroll view's own coordinates,
// ignoring transforms. The keyboard lifts the chat with a translateY, so on iPhones the blur lands
// over the readable chat and stays until the next scroll (#7883). React Native hides it for
// inverted lists for the same reason (https://github.com/react/react-native/pull/58684). The app
// draws its own header fade, so every edge is hidden; hiding only top and bottom leaves the side
// effects, which also cover a transformed list on device.
- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
#if defined(__IPHONE_26_0) && __IPHONE_OS_VERSION_MAX_ALLOWED >= __IPHONE_26_0
    if (@available(iOS 26.0, *)) {
      UIScrollView *scrollView = self.scrollView;
      scrollView.topEdgeEffect.hidden = YES;
      scrollView.bottomEdgeEffect.hidden = YES;
      scrollView.leftEdgeEffect.hidden = YES;
      scrollView.rightEdgeEffect.hidden = YES;
    }
#endif
  }
  return self;
}

- (void)mountingTransactionWillMount:(const MountingTransaction &)transaction
                withSurfaceTelemetry:(const SurfaceTelemetry &)surfaceTelemetry
{
  _offsetBeforeMount = self.scrollView.contentOffset;
  _anchorBeforeMount = [self visibleContentAnchor];
  _anchorTagBeforeMount = _anchorBeforeMount.tag;
  [super mountingTransactionWillMount:transaction withSurfaceTelemetry:surfaceTelemetry];
}

- (void)mountingTransactionDidMount:(const MountingTransaction &)transaction
               withSurfaceTelemetry:(const SurfaceTelemetry &)surfaceTelemetry
{
  // The view registry sets a removed view's tag to 0; a released view reads nil here.
  BOOL isAnchorRemoved = _anchorTagBeforeMount != 0 && _anchorBeforeMount.tag != _anchorTagBeforeMount;
  if (isAnchorRemoved || (self.scrollView.isDragging && [self isEndPin:_anchorBeforeMount])) {
    // Without the content-position props, React Native's mount completes without moving the offset.
    SharedViewProps props = _props;
    _props = ScrollViewShadowNode::defaultSharedProps();
    [super mountingTransactionDidMount:transaction withSurfaceTelemetry:surfaceTelemetry];
    _props = props;
    return;
  }
  if (![self didClampOffsetDuringMount]) {
    [super mountingTransactionDidMount:transaction withSurfaceTelemetry:surfaceTelemetry];
    return;
  }
  UIScrollView *scrollView = self.scrollView;
  scrollView.contentOffset = _offsetBeforeMount;
  [super mountingTransactionDidMount:transaction withSurfaceTelemetry:surfaceTelemetry];
  CGFloat y = MAX(MIN(scrollView.contentOffset.y, [self maxOffsetY]), -scrollView.adjustedContentInset.top);
  if (y != scrollView.contentOffset.y) {
    scrollView.contentOffset = CGPointMake(scrollView.contentOffset.x, y);
  }
}

// UIKit moved the offset to the new end while the mount set a smaller contentSize. A user scroll
// never gets here: React Native keeps the offset through contentSize changes while the user scrolls.
- (BOOL)didClampOffsetDuringMount
{
  const auto &props = static_cast<const ScrollViewProps &>(*_props);
  if (!props.maintainVisibleContentPosition) {
    return NO;
  }
  CGFloat y = self.scrollView.contentOffset.y;
  return y < _offsetBeforeMount.y - 0.5 && ABS(y - [self maxOffsetY]) <= 0.5;
}

// The view React Native anchors on for vertical content: the first content child from
// minIndexForVisible that reaches into the viewport, or the last one.
- (UIView *)visibleContentAnchor
{
  const auto &props = static_cast<const ScrollViewProps &>(*_props);
  UIScrollView *scrollView = self.scrollView;
  if (!props.maintainVisibleContentPosition || scrollView.contentSize.width > self.frame.size.width) {
    return nil;
  }
  NSArray<UIView *> *children = [self contentView].subviews;
  NSUInteger first = props.maintainVisibleContentPosition.value().minIndexForVisible;
  for (NSUInteger index = first; index < children.count; ++index) {
    UIView *child = children[index];
    if (CGRectGetMaxY(child.frame) > scrollView.contentOffset.y || index == children.count - 1) {
      return child;
    }
  }
  return nil;
}

- (BOOL)isEndPin:(UIView *)view
{
  return [view isKindOfClass:[RCTViewComponentView class]] &&
      [((RCTViewComponentView *)view).nativeId isEqualToString:@"paseo-end-pin"];
}

- (UIView *)contentView
{
  for (UIView *child in self.containerView.subviews) {
    if (![child conformsToProtocol:@protocol(RCTCustomPullToRefreshViewProtocol)]) {
      return child;
    }
  }
  return nil;
}

- (CGFloat)maxOffsetY
{
  UIScrollView *scrollView = self.scrollView;
  return MAX(
      scrollView.contentSize.height - scrollView.bounds.size.height + scrollView.adjustedContentInset.bottom,
      -scrollView.adjustedContentInset.top);
}

@end
