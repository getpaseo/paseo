#import "ENRMSpoilerOverlayView.h"
#import "ENRMParticleOverlayView.h"
#import "ENRMSolidOverlayView.h"
#import <QuartzCore/QuartzCore.h>

static const NSTimeInterval kRevealDuration = 0.45;

ENRMSpoilerOverlay ENRMSpoilerOverlayFromString(NSString *string)
{
  if ([string isEqualToString:@"solid"]) {
    return ENRMSpoilerOverlaySolid;
  }
  return ENRMSpoilerOverlayParticles;
}

@implementation ENRMSpoilerOverlayView

- (instancetype)initWithCharRange:(NSRange)charRange
{
  if (self = [super initWithFrame:CGRectZero]) {
    _charRange = charRange;
    _revealing = NO;
#if !TARGET_OS_OSX
    self.userInteractionEnabled = NO;
    self.clipsToBounds = YES;
#else
    self.wantsLayer = YES;
    self.layer.masksToBounds = YES;
#endif
  }
  return self;
}

#pragma mark - Background helper

- (CGColorRef)resolveBackgroundCGColor
{
#if !TARGET_OS_OSX
  for (UIView *view = self.superview; view; view = view.superview) {
    CGColorRef color = view.backgroundColor.CGColor;
    if (color && CGColorGetAlpha(color) > 0)
      return color;
  }
  return [UIColor whiteColor].CGColor;
#else
  for (NSView *view = self.superview; view; view = view.superview) {
    CGColorRef color = view.layer.backgroundColor;
    if (color && CGColorGetAlpha(color) > 0)
      return color;
  }
  return [NSColor whiteColor].CGColor;
#endif
}

#pragma mark - Lifecycle → subclass hooks

#if !TARGET_OS_OSX
- (void)didMoveToSuperview
{
  [super didMoveToSuperview];
  if (self.superview)
    [self didAttachToSuperview];
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  [self didLayoutOverlay];
}
#else
- (void)viewDidMoveToSuperview
{
  [super viewDidMoveToSuperview];
  if (self.superview)
    [self didAttachToSuperview];
}

- (void)layout
{
  [super layout];
  [self didLayoutOverlay];
}
#endif

#pragma mark - Subclass hooks (no-op defaults)

- (void)didAttachToSuperview
{
}

- (void)didLayoutOverlay
{
}

- (void)prepareRevealAnimation
{
}

#pragma mark - Reveal animation

- (void)animateRevealWithCompletion:(dispatch_block_t)completion
{
  if (_revealing)
    return;
  _revealing = YES;

  [self prepareRevealAnimation];

  __weak typeof(self) weakSelf = self;
  [CATransaction begin];
  [CATransaction setCompletionBlock:^{
    if (completion)
      completion();
    [weakSelf removeFromSuperview];
  }];

  CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
  fade.fromValue = @1.0;
  fade.toValue = @0.0;
  fade.duration = kRevealDuration;
  fade.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.0:0.0:0.58:1.0];
  fade.fillMode = kCAFillModeForwards;
  fade.removedOnCompletion = NO;
  [self.layer addAnimation:fade forKey:@"fadeOut"];

  [CATransaction commit];
}

#pragma mark - Factory

+ (ENRMSpoilerOverlayView *)overlayWithMode:(ENRMSpoilerOverlay)mode
                                     config:(StyleConfig *)config
                                  charRange:(NSRange)charRange
{
  switch (mode) {
    case ENRMSpoilerOverlaySolid:
      return [[ENRMSolidOverlayView alloc] initWithConfig:config charRange:charRange];
    case ENRMSpoilerOverlayParticles:
    default:
      return [[ENRMParticleOverlayView alloc] initWithConfig:config charRange:charRange];
  }
}

@end
