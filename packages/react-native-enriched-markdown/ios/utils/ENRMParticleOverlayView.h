#pragma once
#import "ENRMSpoilerOverlayView.h"

NS_ASSUME_NONNULL_BEGIN

@interface ENRMParticleOverlayView : ENRMSpoilerOverlayView

- (instancetype)initWithConfig:(StyleConfig *)config charRange:(NSRange)charRange;

@end

NS_ASSUME_NONNULL_END
