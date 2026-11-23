#pragma once

#import "ENRMInputDecorationDrawer.h"
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

/// Draws list markers (bullets / ordered numbers) into the head-indent column.
@interface ENRMInputListMarkerDrawer : NSObject <ENRMInputDecorationDrawer>

@property (nonatomic, assign) NSInteger emptyBulletDepth;
@property (nonatomic, assign) BOOL emptyBulletOrdered;
@property (nonatomic, assign) NSInteger emptyBulletOrdinal;
@property (nonatomic, assign) NSUInteger emptyBulletLocation;
@property (nonatomic, strong, nullable) UIFont *emptyBulletFont;
@property (nonatomic, strong, nullable) RCTUIColor *emptyBulletColor;
@property (nonatomic, assign) BOOL emptyBulletRTL;
@property (nonatomic, assign) CGFloat listItemSpacing;

#if !TARGET_OS_OSX
/// Shows or updates a subview overlay that draws the trailing empty line's
/// bullet.  drawGlyphsForGlyphRange: clips to the glyph area, which excludes
/// the extra line fragment -- a subview is immune to that clipping.
- (void)showTrailingBulletInTextView:(UITextView *)textView
                       textContainer:(NSTextContainer *)container
                            usedRect:(CGRect)usedRect;
- (void)hideTrailingBullet;
#endif

@end

NS_ASSUME_NONNULL_END
