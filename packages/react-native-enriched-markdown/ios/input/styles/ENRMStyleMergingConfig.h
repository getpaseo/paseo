#pragma once

#import "ENRMInputStyledRange.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Declarative rules for style coexistence.
 *
 * conflictingStyles — mutually exclusive: when this style is applied,
 *   conflicting styles are removed from the same range.
 * blockingStyles — when any blocking style is active at the cursor/range,
 *   this style cannot be toggled on.
 */
@interface ENRMStyleMergingConfig : NSObject

@property (nonatomic, strong) NSSet<NSNumber *> *conflictingStyles;
@property (nonatomic, strong) NSSet<NSNumber *> *blockingStyles;

+ (instancetype)configWithConflicting:(NSSet<NSNumber *> *)conflicting blocking:(NSSet<NSNumber *> *)blocking;
+ (instancetype)emptyConfig;

@end

NS_ASSUME_NONNULL_END
