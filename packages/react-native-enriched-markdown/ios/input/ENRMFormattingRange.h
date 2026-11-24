#pragma once

#import "ENRMInputStyledRange.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ENRMFormattingRange : NSObject <NSCopying>

@property (nonatomic, assign) ENRMInputStyleType type;
@property (nonatomic, assign) NSRange range;
@property (nonatomic, strong, nullable) NSString *url;

+ (instancetype)rangeWithType:(ENRMInputStyleType)type range:(NSRange)range;
+ (instancetype)rangeWithType:(ENRMInputStyleType)type range:(NSRange)range url:(nullable NSString *)url;

@end

NS_ASSUME_NONNULL_END
