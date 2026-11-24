#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

@interface ThematicBreakAttachment : NSTextAttachment

@property (nonatomic, strong) RCTUIColor *lineColor;
@property (nonatomic, assign) CGFloat lineHeight;
@property (nonatomic, assign) CGFloat marginTop;
@property (nonatomic, assign) CGFloat marginBottom;

@end

NS_ASSUME_NONNULL_END
