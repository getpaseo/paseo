#include <TargetConditionals.h>

#if TARGET_OS_OSX
#import "ENRMMenuAction.h"

@implementation ENRMMenuAction {
  void (^_block)(void);
}

- (instancetype)initWithBlock:(void (^)(void))block
{
  self = [super init];
  if (self) {
    _block = [block copy];
  }
  return self;
}

- (BOOL)validateMenuItem:(NSMenuItem *)menuItem
{
  return YES;
}

- (void)performAction:(id)sender
{
  if (_block) {
    _block();
  }
}

@end

#endif // TARGET_OS_OSX
