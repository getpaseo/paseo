#import "ENRMUIKit.h"

@interface FontScaleObserver : NSObject

@property (nonatomic, assign) BOOL allowFontScaling;
@property (nonatomic, readonly) CGFloat effectiveFontScale;

@property (nonatomic, copy, nullable) void (^onChange)(void);

@end
