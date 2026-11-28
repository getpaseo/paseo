#import "ENRMBlockRange.h"

@implementation ENRMBlockRange

+ (instancetype)rangeWithType:(ENRMInputBlockType)type range:(NSRange)range
{
  return [self rangeWithType:type range:range level:0];
}

+ (instancetype)rangeWithType:(ENRMInputBlockType)type range:(NSRange)range level:(NSInteger)level
{
  ENRMBlockRange *blockRange = [[ENRMBlockRange alloc] init];
  blockRange.type = type;
  blockRange.range = range;
  blockRange.level = level;
  blockRange.ordinal = 1;
  return blockRange;
}

- (id)copyWithZone:(NSZone *)zone
{
  ENRMBlockRange *copy = [[ENRMBlockRange allocWithZone:zone] init];
  copy.type = _type;
  copy.range = _range;
  copy.level = _level;
  copy.ordinal = _ordinal;
  return copy;
}

@end
