#import "ENRMDetectorPipeline.h"

#import "ENRMWordsUtils.h"

@implementation ENRMDetectorPipeline {
  NSMutableArray<id<ENRMTextDetector>> *_detectors;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _detectors = [NSMutableArray array];
  }
  return self;
}

- (void)addDetector:(id<ENRMTextDetector>)detector
{
  [_detectors addObject:detector];
}

- (void)processTextChange:(NSString *)text modificationRange:(NSRange)range
{
  NSArray<ENRMWordResult *> *words = [ENRMWordsUtils getAffectedWordsFromText:text modificationRange:range];

  for (ENRMWordResult *wordResult in words) {
    for (id<ENRMTextDetector> detector in _detectors) {
      [detector processWord:wordResult];
    }
  }
}

- (void)refreshAllStyling
{
  for (id<ENRMTextDetector> detector in _detectors) {
    [detector refreshStyling];
  }
}

- (NSArray<ENRMFormattingRange *> *)allTransientFormattingRanges
{
  NSMutableArray<ENRMFormattingRange *> *all = [NSMutableArray array];
  for (id<ENRMTextDetector> detector in _detectors) {
    NSArray<ENRMFormattingRange *> *ranges = [detector transientFormattingRanges];
    if (ranges.count > 0) {
      [all addObjectsFromArray:ranges];
    }
  }
  return all;
}

@end
