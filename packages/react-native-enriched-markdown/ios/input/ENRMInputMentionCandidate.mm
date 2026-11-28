#import "ENRMInputMentionCandidate.h"

@implementation ENRMInputMentionCandidate

+ (instancetype)candidateWithIndicator:(NSString *)indicator
                                 start:(NSUInteger)start
                                   end:(NSUInteger)end
                                  text:(NSString *)text
{
  ENRMInputMentionCandidate *candidate = [[self alloc] init];
  candidate.indicator = indicator;
  candidate.start = start;
  candidate.end = end;
  candidate.text = text;
  return candidate;
}

@end
