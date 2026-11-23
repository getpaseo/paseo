#pragma once
#import "ENRMUIKit.h"

@class ENRMSpoilerOverlayManager;

NS_ASSUME_NONNULL_BEGIN

@protocol ENRMSpoilerCapable <NSObject>

@property (nonatomic, readonly) ENRMPlatformTextView *textView;
@property (nonatomic, readonly) ENRMSpoilerOverlayManager *spoilerManager;

@end

NS_ASSUME_NONNULL_END
