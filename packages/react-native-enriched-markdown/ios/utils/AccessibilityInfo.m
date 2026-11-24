#import "AccessibilityInfo.h"
#import "RenderContext.h"

@implementation AccessibilityInfo

+ (instancetype)infoFromContext:(RenderContext *)context
{
  AccessibilityInfo *info = [[AccessibilityInfo alloc] init];
  if (info) {
    info->_headingRanges = [context.headingRanges copy];
    info->_headingLevels = [context.headingLevels copy];
    info->_linkRanges = [context.linkRanges copy];
    info->_linkURLs = [context.linkURLs copy];
    info->_imageRanges = [context.imageRanges copy];
    info->_imageAltTexts = [context.imageAltTexts copy];
    info->_listItemRanges = [context.listItemRanges copy];
    info->_listItemPositions = [context.listItemPositions copy];
    info->_listItemDepths = [context.listItemDepths copy];
    info->_listItemOrdered = [context.listItemOrdered copy];
  }
  return info;
}

@end
