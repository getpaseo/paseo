#pragma once
#import "ENRMUIKit.h"
#import "StyleConfig.h"

NS_ASSUME_NONNULL_BEGIN

extern NSString *const BlockquoteDepthAttributeName;
extern NSString *const BlockquoteBackgroundColorAttributeName;
extern NSString *const BlockquoteSpacerAttributeName;

static inline CGFloat blockquoteIndentForDepth(NSInteger depth, CGFloat levelSpacing)
{
  return depth * levelSpacing;
}

@interface BlockquoteBorder : NSObject

- (instancetype)initWithConfig:(StyleConfig *)config;
- (void)drawBordersForGlyphRange:(NSRange)glyphsToShow
                   layoutManager:(NSLayoutManager *)layoutManager
                   textContainer:(NSTextContainer *)textContainer
                         atPoint:(CGPoint)origin;

@end

NS_ASSUME_NONNULL_END
