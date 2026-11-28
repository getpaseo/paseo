#pragma once

#import "ENRMClipboardCoordinator.h"
#import "ENRMFormattingRange.h"
#import "ENRMTextDetector.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Coordinates a set of ENRMTextDetector instances. The input view calls
/// this pipeline instead of individual detectors.
@interface ENRMDetectorPipeline : NSObject <ENRMTransientRangeProvider>

- (void)addDetector:(id<ENRMTextDetector>)detector;

/// Run all detectors over the affected words for a given modification range.
- (void)processTextChange:(NSString *)text modificationRange:(NSRange)range;

/// Re-apply visual styling for all detectors after the formatter
/// resets base attributes. Call right after applyFormattingRanges.
- (void)refreshAllStyling;

/// Collect transient formatting ranges from every detector,
/// suitable for merging with FormattingStore ranges before serialization.
- (NSArray<ENRMFormattingRange *> *)allTransientFormattingRanges;

@end

NS_ASSUME_NONNULL_END
