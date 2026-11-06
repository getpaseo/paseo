#import <React/RCTComponentViewFactory.h>
#import <React/RCTScrollViewComponentView.h>

@interface PaseoScrollViewComponentView : RCTScrollViewComponentView
@end

@implementation PaseoScrollViewComponentView

// Register before the first Fabric surface creates a ScrollView.
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

@end
