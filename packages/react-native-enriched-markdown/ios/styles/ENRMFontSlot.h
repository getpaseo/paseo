#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

@interface ENRMFontSlot : NSObject <NSCopying>
@property (nonatomic) BOOL needsRecreation;
@property (nonatomic, strong, nullable) UIFont *cachedFont;
- (void)invalidate;
@end

NS_ASSUME_NONNULL_END
