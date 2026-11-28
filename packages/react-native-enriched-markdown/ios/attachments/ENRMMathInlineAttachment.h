#pragma once
#import "ENRMLatexErrorReporting.h"
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

@interface ENRMMathInlineAttachment : NSTextAttachment <ENRMLatexErrorReporting>

@property (nonatomic, strong) NSString *latex;
@property (nonatomic, assign) CGFloat fontSize;
@property (nonatomic, strong, nullable) RCTUIColor *mathTextColor;
@property (nonatomic, assign) BOOL displayMode;
@property (nonatomic, copy, nullable) ENRMLatexErrorHandler onLatexError;

@property (nonatomic, readonly) CGFloat boxHeight;

#if TARGET_OS_OSX
/// Pre-renders the formula into self.image and sets self.bounds.
/// Must be called after latex/fontSize/mathTextColor are set, before the
/// attachment is inserted into an NSAttributedString. On macOS, NSLayoutManager
/// uses the image/bounds properties directly rather than calling imageForBounds:.
- (void)renderForMacOS;
#endif

@end

NS_ASSUME_NONNULL_END
