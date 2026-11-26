#import "ENRMSolidOverlayView.h"

@implementation ENRMSolidOverlayView {
  RCTUIColor *_solidColor;
  CGFloat _borderRadius;
}

- (instancetype)initWithConfig:(StyleConfig *)config charRange:(NSRange)charRange
{
  if (self = [super initWithCharRange:charRange]) {
    _solidColor = [config spoilerColor];
    _borderRadius = [config spoilerSolidBorderRadius];
  }
  return self;
}

#pragma mark - Overrides

- (void)didAttachToSuperview
{
  self.layer.backgroundColor = _solidColor.CGColor;
  self.layer.cornerRadius = _borderRadius;
}

@end
