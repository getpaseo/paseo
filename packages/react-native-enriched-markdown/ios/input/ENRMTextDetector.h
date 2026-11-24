#pragma once

#import "ENRMWordsUtils.h"
#import <Foundation/Foundation.h>

@class ENRMFormattingRange;

NS_ASSUME_NONNULL_BEGIN

/// Protocol for pluggable text detectors that run after each text edit.
/// Each detector scans affected words, can refresh its own visual styling
/// after the formatter resets base attributes, and contributes transient
/// formatting ranges for markdown serialization.
@protocol ENRMTextDetector <NSObject>

/// Process a single word at the given range after a text edit.
/// Called once per affected word in the modification range.
- (void)processWord:(ENRMWordResult *)wordResult;

/// Re-apply any visual styling owned by this detector.
/// Called after the formatter resets base text attributes.
- (void)refreshStyling;

/// Return transient formatting ranges that should be merged
/// with the FormattingStore ranges during markdown serialization.
- (NSArray<ENRMFormattingRange *> *)transientFormattingRanges;

@end

NS_ASSUME_NONNULL_END
