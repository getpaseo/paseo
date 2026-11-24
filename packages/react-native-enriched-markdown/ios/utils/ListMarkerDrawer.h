#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

@class StyleConfig;

@interface ListMarkerDrawer : NSObject

- (instancetype)initWithConfig:(StyleConfig *)config;

- (void)drawMarkersForGlyphRange:(NSRange)glyphsToShow
                   layoutManager:(NSLayoutManager *)layoutManager
                   textContainer:(NSTextContainer *)textContainer
                         atPoint:(CGPoint)origin;

@end
