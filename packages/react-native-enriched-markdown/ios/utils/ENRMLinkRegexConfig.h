#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ENRMLinkRegexConfig : NSObject

@property (nonatomic, copy, readonly) NSString *pattern;
@property (nonatomic, assign, readonly) BOOL caseInsensitive;
@property (nonatomic, assign, readonly) BOOL dotAll;
@property (nonatomic, assign, readonly) BOOL isDisabled;
@property (nonatomic, assign, readonly) BOOL isDefault;
@property (nonatomic, strong, readonly, nullable) NSRegularExpression *parsedRegex;
@property (nonatomic, strong, readonly, nullable) NSRegularExpression *parsedWholeSpanRegex;

- (instancetype)initWithPattern:(NSString *)pattern
                caseInsensitive:(BOOL)caseInsensitive
                         dotAll:(BOOL)dotAll
                     isDisabled:(BOOL)isDisabled
                      isDefault:(BOOL)isDefault;

/// Shared instance per pattern and flags; the renderer's props go through here. Thread-safe.
+ (instancetype)cachedConfigWithPattern:(NSString *)pattern caseInsensitive:(BOOL)caseInsensitive dotAll:(BOOL)dotAll;

- (BOOL)isEqualToConfig:(nullable ENRMLinkRegexConfig *)other;

@end

NS_ASSUME_NONNULL_END
