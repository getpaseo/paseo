#pragma once

#import "ENRMBlockRange.h"
#import "ENRMFormattingRange.h"
#import <Foundation/Foundation.h>

@class ENRMFormattingStore;
@class ENRMBlockStore;
@class ENRMInputFormatter;
@protocol ENRMDetectorPipelineTransientRanges;

NS_ASSUME_NONNULL_BEGIN

@protocol ENRMTransientRangeProvider <NSObject>
- (NSArray<ENRMFormattingRange *> *)allTransientFormattingRanges;
@end

@interface ENRMClipboardCoordinator : NSObject

- (instancetype)initWithFormattingStore:(ENRMFormattingStore *)formattingStore
                             blockStore:(ENRMBlockStore *)blockStore
                 transientRangeProvider:(id<ENRMTransientRangeProvider>)transientRangeProvider
                              formatter:(ENRMInputFormatter *)formatter;

- (NSArray<ENRMFormattingRange *> *)allRangesIncludingTransient;

- (NSString *)serializeText:(NSString *)text
                     ranges:(NSArray<ENRMFormattingRange *> *)ranges
                blockRanges:(NSArray<ENRMBlockRange *> *)blockRanges;

- (NSString *)serializeFullDocument:(NSString *)plainText;

- (nullable NSString *)serializeSelectedRange:(NSRange)selection inText:(NSString *)fullText;

@end

NS_ASSUME_NONNULL_END
