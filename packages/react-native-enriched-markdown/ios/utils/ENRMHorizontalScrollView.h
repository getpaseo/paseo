#import "ENRMUIKit.h"

/// Horizontal scroll view shared by code blocks, tables and display math.
/// Keep the native scroll recognizer at the leading edge so enclosing sidebar
/// gestures cannot take an outward drag that starts in an overflowing block.
@interface ENRMHorizontalScrollView : RCTUIScrollView
@end
