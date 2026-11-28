#pragma once

#import "ENRMFormattingStore.h"
#import "ENRMLinkCoordinator.h"
#import "ENRMLinkRegexConfig.h"
#import "ENRMTextDetector.h"
#import <Foundation/Foundation.h>

@class ENRMInputFormatterStyle;

NS_ASSUME_NONNULL_BEGIN

typedef void (^ENRMAutoLinkCallback)(NSString *text, NSString *url, NSRange range);

@interface ENRMAutoLinkDetector : NSObject <ENRMTextDetector, ENRMAutoLinkDetecting>

- (instancetype)initWithTextStorage:(NSTextStorage *)textStorage
                    formattingStore:(ENRMFormattingStore *)store
                              style:(ENRMInputFormatterStyle *)style;

- (void)setRegexConfig:(ENRMLinkRegexConfig *)config;

/// Callback invoked when a new auto-link is detected.
/// Set by the input view to bridge detections to JS event emission.
@property (nonatomic, copy, nullable) ENRMAutoLinkCallback onLinkDetected;

/// Remove any auto-link marker attribute in the given range.
/// Call when a manual link is applied over an auto-detected one.
- (void)clearAutoLinkInRange:(NSRange)range;

@end

NS_ASSUME_NONNULL_END
