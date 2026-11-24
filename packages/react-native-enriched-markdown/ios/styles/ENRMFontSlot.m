#import "ENRMFontSlot.h"

@implementation ENRMFontSlot

- (instancetype)init
{
  if (self = [super init]) {
    _needsRecreation = YES;
  }
  return self;
}

- (void)invalidate
{
  _needsRecreation = YES;
  _cachedFont = nil;
}

- (id)copyWithZone:(NSZone *)zone
{
  return [[[self class] allocWithZone:zone] init];
}

@end
