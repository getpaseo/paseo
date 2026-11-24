#pragma once

#import "ENRMInputBlockType.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// A block-level element occupying a paragraph/line range. Mirrors
/// ENRMFormattingRange but for block scope: the range always covers whole lines.
@interface ENRMBlockRange : NSObject <NSCopying>

@property (nonatomic, assign) ENRMInputBlockType type;
@property (nonatomic, assign) NSRange range;

/// Generic integer payload for the block. 0 by default. Headings use it for the
/// H-level (1-6); list items use it for nesting depth.
@property (nonatomic, assign) NSInteger level;

/// 1-based position of an ordered item among its adjacent same-depth siblings;
/// recomputed by the block store's list-metadata pass.
@property (nonatomic, assign) NSInteger ordinal;

+ (instancetype)rangeWithType:(ENRMInputBlockType)type range:(NSRange)range;
+ (instancetype)rangeWithType:(ENRMInputBlockType)type range:(NSRange)range level:(NSInteger)level;

@end

NS_ASSUME_NONNULL_END
