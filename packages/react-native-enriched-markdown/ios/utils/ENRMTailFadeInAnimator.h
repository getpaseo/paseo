#pragma once
#import "ENRMUIKit.h"
#import "LinkTapUtils.h"

NS_ASSUME_NONNULL_BEGIN

@interface ENRMTailFadeInAnimator : NSObject

- (instancetype)initWithTextView:(ENRMPlatformTextView *)textView;

- (void)animateFrom:(NSUInteger)tailStart to:(NSUInteger)tailEnd;
- (void)cancel;

@end

NS_ASSUME_NONNULL_END
