#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ENRMWordResult : NSObject

@property (nonatomic, copy, readonly) NSString *word;
@property (nonatomic, assign, readonly) NSRange range;

+ (instancetype)resultWithWord:(NSString *)word range:(NSRange)range;

@end

@interface ENRMWordsUtils : NSObject

/// Returns the start index of the non-whitespace token that ends at [position].
/// If [position] is directly after whitespace or at the start of text, returns [position].
+ (NSUInteger)tokenStartInText:(NSString *)text beforePosition:(NSUInteger)position;

/// Expands the modification range to word boundaries, then splits into
/// individual ENRMWordResult objects.
+ (NSArray<ENRMWordResult *> *)getAffectedWordsFromText:(NSString *)text modificationRange:(NSRange)range;

@end

NS_ASSUME_NONNULL_END
