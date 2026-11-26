#import "ENRMStyleMergingConfig.h"

@implementation ENRMStyleMergingConfig

+ (instancetype)configWithConflicting:(NSSet<NSNumber *> *)conflicting blocking:(NSSet<NSNumber *> *)blocking
{
  ENRMStyleMergingConfig *config = [[ENRMStyleMergingConfig alloc] init];
  config.conflictingStyles = conflicting;
  config.blockingStyles = blocking;
  return config;
}

+ (instancetype)emptyConfig
{
  static ENRMStyleMergingConfig *shared;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{ shared = [self configWithConflicting:[NSSet set] blocking:[NSSet set]]; });
  return shared;
}

@end
