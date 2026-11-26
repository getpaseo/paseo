#import "ENRMFormattingRange.h"

@implementation ENRMFormattingRange

+ (instancetype)rangeWithType:(ENRMInputStyleType)type range:(NSRange)range
{
  return [self rangeWithType:type range:range url:nil];
}

+ (instancetype)rangeWithType:(ENRMInputStyleType)type range:(NSRange)range url:(nullable NSString *)url
{
  ENRMFormattingRange *formattingRange = [[ENRMFormattingRange alloc] init];
  formattingRange.type = type;
  formattingRange.range = range;
  formattingRange.url = url;
  return formattingRange;
}

- (id)copyWithZone:(NSZone *)zone
{
  ENRMFormattingRange *copy = [[ENRMFormattingRange allocWithZone:zone] init];
  copy.type = _type;
  copy.range = _range;
  copy.url = [_url copy];
  return copy;
}

@end
