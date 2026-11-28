#pragma once

#import "ENRMBlockRange.h"
#import "ENRMFormattingRange.h"

NS_ASSUME_NONNULL_BEGIN

@interface ENRMMarkdownSerializer : NSObject

+ (NSString *)serializePlainText:(NSString *)text ranges:(NSArray<ENRMFormattingRange *> *)ranges;

/// Block-aware serialization: serializes inline styles exactly as the inline-only
/// overload, then prepends each line's block prefix. `prefixProvider` is asked,
/// per block range, for the markdown line marker (e.g. @"# ", @"- "); returning
/// @"" or nil leaves the line unprefixed. With empty `blockRanges` the output is
/// identical to the inline-only overload.
+ (NSString *)serializePlainText:(NSString *)text
                          ranges:(NSArray<ENRMFormattingRange *> *)ranges
                     blockRanges:(NSArray<ENRMBlockRange *> *)blockRanges
             blockPrefixProvider:(NSString *_Nullable (^_Nullable)(ENRMBlockRange *blockRange))prefixProvider;

@end

NS_ASSUME_NONNULL_END
