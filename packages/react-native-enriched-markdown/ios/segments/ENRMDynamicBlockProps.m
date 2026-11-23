#import "ENRMDynamicBlockProps.h"

@implementation ENRMDynamicBlockProps

- (instancetype)init
{
  self = [super init];
  if (self) {
    _enableLinkPreview = YES;
    _enableBlockContextMenu = YES;
    _enableCodeBlockPress = NO;
  }
  return self;
}

@end
